"use strict";
require('dotenv').config();
const express = require("express");
const line = require("@line/bot-sdk");
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');

const PORT = process.env.PORT || 5000;

// LINE Bot設定
const config = {
    channelSecret: process.env.LINE_CHANNEL_SECRET || "162400cfc8a09a24918e963c5f2cd27b",
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "AS8xkZaKSKh9OjFDXHI8zCo4VXIBH6+cDEICFBi5vPgnsy6QOfD7ia88+Fb/Jjm/yqV8U3KFqDnA+qxcfU477fPuvFJAXVRGpZ75w64HvuxFVeeQkUreKmw+js+vHTkbEgI8zuBjGpskQ7EtJ/SWdwdB04t89/1O/w1cDnyilFU="
};

// Notion設定
const notion = new Client({
    auth: process.env.NOTION_API_KEY || "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"
});
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || "1bacb4ce-5b9e-8052-94b3-d06d5d282f51";

// OCR.space APIキー
const OCR_API_KEY = process.env.OCR_API_KEY || "K85126819088957"; // 無料利用枠のデモキー

// Gemini API設定
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyBH8isJ333x0riocYGZG80BJEiyZeRi-Co";

const app = express();

// 重要: LINE Webhookエンドポイントにはボディパーサーを適用しない
// 他のルートには必要に応じてボディパーサーを適用
app.use('/api', express.json());
app.use('/api', express.urlencoded({ extended: true }));

// アップロード用の一時ディレクトリ
const upload = multer({ dest: 'uploads/' });

// 処理済みメッセージを追跡するためのMap
// キー: メッセージID, 値: {timestamp: 処理時間, count: 処理回数}
const processedMessages = new Map();

// メッセージIDとユーザーIDの対応を保存するためのMap
// キー: メッセージID, 値: {userId: ユーザーID, timestamp: 保存時間}
const messageUserMap = new Map();

// ユーザーの状態を管理するためのMap
// キー: ユーザーID, 値: {
//   currentData: {storeName, amount, date, category}, 
//   editMode: boolean, 
//   editField: string,
//   notionPageId: string (編集時のみ)
// }
const userStates = new Map();

// 処理済みメッセージの保持期間(ミリ秒)
const MESSAGE_RETENTION_PERIOD = 60 * 60 * 1000; // 1時間

// 定期的に古いメッセージIDを削除する処理
setInterval(() => {
  const now = Date.now();
  
  // 処理済みメッセージの掃除
  for (const [messageId, data] of processedMessages.entries()) {
    if (now - data.timestamp > MESSAGE_RETENTION_PERIOD) {
      processedMessages.delete(messageId);
    }
  }
  
  // メッセージ-ユーザーマッピングの掃除
  for (const [messageId, data] of messageUserMap.entries()) {
    if (now - data.timestamp > MESSAGE_RETENTION_PERIOD) {
      messageUserMap.delete(messageId);
    }
  }
  
  // 古いユーザー状態の掃除（1時間以上更新がないものを削除）
  for (const [userId, data] of userStates.entries()) {
    if (data.timestamp && now - data.timestamp > MESSAGE_RETENTION_PERIOD) {
      userStates.delete(userId);
    }
  }
}, 30 * 60 * 1000); // 30分ごとに掃除

// webhookルートに対してのみLINEミドルウェアを適用
app.post("/webhook", line.middleware(config), (req, res) => {
  console.log("リクエスト受信：", req.body.events);
  
  // 各イベントについて、メッセージIDとユーザーIDのマッピングを保存
  req.body.events.forEach(event => {
    if (event.type === "message" && event.message && event.source && event.source.userId) {
      messageUserMap.set(event.message.id, {
        userId: event.source.userId,
        timestamp: Date.now()
      });
      console.log(`メッセージID ${event.message.id} とユーザーID ${event.source.userId} のマッピングを保存しました`);
    }
  });
  
  // すべてのイベントに対して重複チェックを行い、処理済みなら無視する
  const events = req.body.events.filter(event => {
    // ポストバックとテキスト編集モードは常に処理する
    if (event.type === "postback") return true;
    
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      if (userStates.has(userId) && userStates.get(userId).editMode) {
        return true; // 編集モード中のテキストメッセージは常に処理
      }
    }
    
    if (event.type !== "message") return true; // メッセージ以外はそのまま処理
    
    const messageId = event.message.id;
    const now = Date.now();
    
    // 処理済みメッセージの場合
    if (processedMessages.has(messageId)) {
      const data = processedMessages.get(messageId);
      data.count++;
      console.log(`重複メッセージ検出: ${messageId} (${data.count}回目)`);
      return false; // このイベントをスキップ
    }
    
    // 新しいメッセージの場合
    processedMessages.set(messageId, { timestamp: now, count: 1 });
    return true;
  });
  
  // フィルタ後のイベントが空の場合はすぐに応答
  if (events.length === 0) {
    console.log("すべてのイベントが処理済み。スキップします。");
    return res.status(200).end();
  }
  
  // 処理対象のイベントがある場合
  Promise.all(events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("イベント処理エラー：", err);
      res.status(500).end();
    });
});

const client = new line.Client(config);

// デバッグ用のエンドポイント
app.get('/ping', (req, res) => {
  res.send('pong');
});

// カテゴリ一覧（修正オプション用）
const CATEGORIES = ['コンビニ', '食品', '日用品', '雑貨', '服飾', '学習', '娯楽', 'その他'];

async function handleEvent(event) {
  console.log("イベント処理開始:", JSON.stringify(event));
  const userId = event.source.userId;
  
  // ポストバックイベントの処理
  if (event.type === "postback") {
    return handlePostback(event);
  }
  
  if (event.type !== "message") {
    return Promise.resolve(null);
  }

  // 編集モード中のテキスト入力の処理
  if (event.message.type === "text" && userStates.has(userId) && userStates.get(userId).editMode) {
    return handleEditModeText(event);
  }

  // 通常のテキストメッセージの処理
  if (event.message.type === "text") {
    let mes = { type: "text", text: "テキストメッセージを受け取りました。PayPayのスクリーンショットを送信してください。" };
    return client.replyMessage(event.replyToken, mes);
  }
  
  // 画像メッセージの処理
  else if (event.message.type === "image") {
    try {
      // まず即座に応答を返す
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: "画像を受け取りました。解析を開始します..."
      });
      
      // 残りの処理は非同期で行う
      processImageAsync(event.message.id);
      
      // 既に応答を返しているので、ここではnullを返す
      return Promise.resolve(null);
    } catch (error) {
      console.error('メッセージ応答エラー:', error);
      // エラーが発生した場合でも処理を続行する
      return Promise.resolve(null);
    }
  }
  
  return Promise.resolve(null);
}

// ポストバックイベントの処理
async function handlePostback(event) {
  const userId = event.source.userId;
  const data = event.postback.data;
  
  console.log(`ポストバック受信: ${data} from ${userId}`);
  
  // 確認ダイアログの応答処理
  if (data.startsWith('action=')) {
    const action = data.split('=')[1];
    
    if (action === 'modify') {
      // 修正モードを開始
      if (userStates.has(userId) && userStates.get(userId).currentData) {
        const userState = userStates.get(userId);
        userState.editMode = true;
        userState.timestamp = Date.now();
        
        // 修正フィールド選択メニューを表示
        return client.replyMessage(event.replyToken, {
          type: "flex",
          altText: "修正項目を選択してください",
          contents: {
            type: "bubble",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "修正する項目を選択してください",
                  weight: "bold",
                  size: "md"
                }
              ]
            },
            footer: {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              contents: [
                {
                  type: "button",
                  style: "primary",
                  action: {
                    type: "postback",
                    label: "店舗名",
                    data: "edit=storeName"
                  }
                },
                {
                  type: "button",
                  style: "primary",
                  action: {
                    type: "postback",
                    label: "金額",
                    data: "edit=amount"
                  }
                },
                {
                  type: "button",
                  style: "primary",
                  action: {
                    type: "postback",
                    label: "カテゴリ",
                    data: "edit=category"
                  }
                },
                {
                  type: "button",
                  style: "secondary",
                  action: {
                    type: "postback",
                    label: "キャンセル",
                    data: "edit=cancel"
                  }
                }
              ]
            }
          }
        });
      } else {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "修正するデータがありません。先に画像を送信してください。"
        });
      }
    } else if (action === 'save') {
      // データを保存して完了
      if (userStates.has(userId) && userStates.get(userId).currentData) {
        const userState = userStates.get(userId);
        const extractedData = userState.currentData;
        
        try {
          // Notionに保存
          if (NOTION_DATABASE_ID) {
            let saved = false;
            
            // 既存ページの更新（編集モードで、notionPageIdがある場合）
            if (userState.notionPageId) {
              saved = await updateNotion(userState.notionPageId, extractedData, extractedData.category);
            } else {
              // 新規作成
              saved = await addToNotion(extractedData, extractedData.category);
            }
            
            return client.replyMessage(event.replyToken, {
              type: "text",
              text: saved 
                ? "データを保存しました！" 
                : "保存に失敗しました。もう一度試してください。"
            });
          } else {
            return client.replyMessage(event.replyToken, {
              type: "text",
              text: "Notion連携が設定されていないため、保存できません。"
            });
          }
        } finally {
          // 処理完了後、ユーザー状態をリセット
          userState.editMode = false;
          userState.editField = null;
          userState.notionPageId = null;
        }
      } else {
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "保存するデータがありません。先に画像を送信してください。"
        });
      }
    }
  }
  
  // 編集フィールドの選択処理
  else if (data.startsWith('edit=')) {
    const field = data.split('=')[1];
    
    if (field === 'cancel') {
      // 編集モードをキャンセル
      if (userStates.has(userId)) {
        const userState = userStates.get(userId);
        userState.editMode = false;
        userState.editField = null;
      }
      
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "修正をキャンセルしました。"
      });
    }
    
    if (userStates.has(userId) && userStates.get(userId).currentData) {
      const userState = userStates.get(userId);
      userState.editField = field;
      userState.timestamp = Date.now();
      
      if (field === 'category') {
        // カテゴリ選択メニューを表示
        return client.replyMessage(event.replyToken, createCategoryMenu());
      } else {
        // テキスト入力を促す
        const fieldName = field === 'storeName' ? '店舗名' : '金額';
        const currentValue = field === 'storeName' 
          ? userState.currentData.storeName 
          : userState.currentData.amount;
        
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: `新しい${fieldName}を入力してください。\n現在の値: ${currentValue}`
        });
      }
    } else {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "修正するデータがありません。先に画像を送信してください。"
      });
    }
  }
  
  // カテゴリ選択の処理
  else if (data.startsWith('category=')) {
    const category = data.split('=')[1];
    
    if (userStates.has(userId) && userStates.get(userId).editMode) {
      const userState = userStates.get(userId);
      userState.currentData.category = category;
      userState.timestamp = Date.now();
      
      // 更新後のデータを表示し、保存確認
      return client.replyMessage(event.replyToken, createConfirmationMessage(userState.currentData));
    } else {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "カテゴリを選択できませんでした。もう一度試してください。"
      });
    }
  }
  
  return Promise.resolve(null);
}

// 編集モード中のテキスト入力を処理
async function handleEditModeText(event) {
  const userId = event.source.userId;
  const text = event.message.text;
  
  if (userStates.has(userId) && userStates.get(userId).editMode && userStates.get(userId).editField) {
    const userState = userStates.get(userId);
    const field = userState.editField;
    
    // 入力値を対応するフィールドに設定
    if (field === 'storeName') {
      userState.currentData.storeName = text;
    } else if (field === 'amount') {
      // 数値以外の文字を取り除く
      const numericValue = text.replace(/[^0-9]/g, '');
      userState.currentData.amount = numericValue || '0';
    }
    
    userState.timestamp = Date.now();
    userState.editField = null; // 編集フィールドをリセット
    
    // 更新後のデータを表示し、保存確認
    return client.replyMessage(event.replyToken, createConfirmationMessage(userState.currentData));
  }
  
  return Promise.resolve(null);
}

// カテゴリ選択メニューを作成
function createCategoryMenu() {
  const buttons = CATEGORIES.map(category => ({
    type: "button",
    style: "primary",
    action: {
      type: "postback",
      label: category,
      data: `category=${category}`
    },
    color: getCategoryColor(category)
  }));
  
  return {
    type: "flex",
    altText: "カテゴリを選択してください",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "カテゴリを選択してください",
            weight: "bold",
            size: "md"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: buttons
      }
    }
  };
}

// カテゴリに応じた色を返す
function getCategoryColor(category) {
  const colorMap = {
    'コンビニ': "#5F9EA0",
    '食品': "#FF6347",
    '日用品': "#6495ED",
    '雑貨': "#DDA0DD",
    '服飾': "#FFD700",
    '学習': "#32CD32",
    '娯楽': "#FF69B4",
    'その他': "#A9A9A9"
  };
  
  return colorMap[category] || "#A9A9A9";
}

// 確認メッセージを作成
function createConfirmationMessage(data) {
  return {
    type: "flex",
    altText: "情報を確認して保存してください",
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "以下の内容で保存しますか？",
            weight: "bold",
            size: "md"
          }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "店舗:",
                size: "sm",
                color: "#555555",
                flex: 2
              },
              {
                type: "text",
                text: data.storeName,
                size: "sm",
                color: "#111111",
                flex: 4,
                wrap: true
              }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "金額:",
                size: "sm",
                color: "#555555",
                flex: 2
              },
              {
                type: "text",
                text: `${parseInt(data.amount).toLocaleString()}円`,
                size: "sm",
                color: "#111111",
                flex: 4
              }
            ],
            margin: "md"
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "日付:",
                size: "sm",
                color: "#555555",
                flex: 2
              },
              {
                type: "text",
                text: data.date,
                size: "sm",
                color: "#111111",
                flex: 4
              }
            ],
            margin: "md"
          },
          {
            type: "box",
            layout: "horizontal",
            contents: [
              {
                type: "text",
                text: "分類:",
                size: "sm",
                color: "#555555",
                flex: 2
              },
              {
                type: "text",
                text: data.category,
                size: "sm",
                color: "#111111",
                flex: 4
              }
            ],
            margin: "md"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "保存する",
              data: "action=save"
            }
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "修正する",
              data: "action=modify"
            }
          }
        ]
      }
    }
  };
}

// 決定確認メッセージを作成
function createFinalConfirmMessage(data) {
  return {
    type: "flex",
    altText: "修正する必要はありますか？",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "読み取り結果",
            weight: "bold",
            size: "xl",
            margin: "md"
          },
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "店舗:",
                    size: "sm",
                    color: "#555555",
                    flex: 2
                  },
                  {
                    type: "text",
                    text: data.storeName,
                    size: "sm",
                    color: "#111111",
                    flex: 4,
                    wrap: true
                  }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "金額:",
                    size: "sm",
                    color: "#555555",
                    flex: 2
                  },
                  {
                    type: "text",
                    text: `${parseInt(data.amount).toLocaleString()}円`,
                    size: "sm",
                    color: "#111111",
                    flex: 4
                  }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "日付:",
                    size: "sm",
                    color: "#555555",
                    flex: 2
                  },
                  {
                    type: "text",
                    text: data.date,
                    size: "sm",
                    color: "#111111",
                    flex: 4
                  }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "text",
                    text: "分類:",
                    size: "sm",
                    color: "#555555",
                    flex: 2
                  },
                  {
                    type: "text",
                    text: data.category,
                    size: "sm",
                    color: "#111111",
                    flex: 4
                  }
                ]
              }
            ]
          },
          {
            type: "text",
            text: "上記の内容で正しいですか？",
            margin: "xxl",
            size: "md",
            weight: "bold"
          }
        ]
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "保存する",
              data: "action=save"
            }
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "修正する",
              data: "action=modify"
            }
          }
        ]
      }
    }
  };
}

// メッセージIDからユーザーIDを取得する関数
async function getUserIdFromMessageId(messageId) {
  if (messageUserMap.has(messageId)) {
    const userId = messageUserMap.get(messageId).userId;
    console.log(`メッセージID ${messageId} からユーザーID ${userId} を取得しました`);
    return userId;
  }
  console.log(`メッセージID ${messageId} に対応するユーザーIDが見つかりませんでした`);
  return null;
}

// 画像を非同期で処理する関数
async function processImageAsync(messageId) {
  try {
    // LINE Messaging APIから画像を取得
    console.log("画像メッセージID:", messageId);
    const stream = await client.getMessageContent(messageId);
    let chunks = [];
    
    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    stream.on('end', async () => {
      try {
        console.log("画像データの取得完了");
        const imageBuffer = Buffer.concat(chunks);
        
        // ディレクトリが存在しない場合は作成
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        // 一時的にファイルに保存
        const tempFilePath = path.join(uploadsDir, `temp_${messageId}.jpg`);
        fs.writeFileSync(tempFilePath, imageBuffer);
        console.log("画像を保存しました:", tempFilePath);
        
        // 画像からテキストを抽出（OCR.space APIを使用）
        console.log("OCR処理を開始します");
        const extractedData = await extractDataFromImage(tempFilePath);
        console.log("抽出データ:", extractedData);
        
        // 抽出したデータからカテゴリを判定
        console.log("カテゴリ判定を開始します");
        const category = await categorizePayment(extractedData);
        console.log("判定されたカテゴリ:", category);
        
        // ユーザーID取得
        const userId = await getUserIdFromMessageId(messageId);
        if (!userId) {
          console.log("ユーザーIDが見つからないため、処理を中断します");
          return;
        }
        
        // 現在のデータをユーザー状態に保存
        const fullData = {
          ...extractedData,
          category: category
        };
        
        // ユーザー状態を初期化または更新
        if (!userStates.has(userId)) {
          userStates.set(userId, {
            currentData: fullData,
            editMode: false,
            editField: null,
            timestamp: Date.now()
          });
        } else {
          const userState = userStates.get(userId);
          userState.currentData = fullData;
          userState.editMode = false;
          userState.editField = null;
          userState.timestamp = Date.now();
        }
        
        // 確認メッセージを送信
        await client.pushMessage(userId, createFinalConfirmMessage(fullData));
        
        // 一時ファイルの削除
        fs.unlinkSync(tempFilePath);
        console.log("一時ファイルを削除しました");
      } catch (error) {
        console.error('画像処理エラー:', error);
        // エラーメッセージをプッシュ通知
        const userId = await getUserIdFromMessageId(messageId);
        if (userId) {
          await client.pushMessage(userId, {
            type: "text",
            text: "画像の処理中にエラーが発生しました。もう一度試してください。エラー詳細: " + error.message
          });
        }
      }
    });
    
    stream.on('error', async (err) => {
      console.error('画像取得エラー:', err);
      // エラーメッセージをプッシュ通知
      const userId = await getUserIdFromMessageId(messageId);
      if (userId) {
        await client.pushMessage(userId, {
          type: "text",
          text: "画像の取得中にエラーが発生しました。もう一度試してください。"
        });
      }
    });
  } catch (error) {
    console.error('画像処理開始エラー:', error);
  }
}

// 画像からデータを抽出する関数（OCR.space APIを使用）
async function extractDataFromImage(imagePath) {
  console.log(`OCR処理: ${imagePath}`);
  
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(imagePath));
    formData.append('apikey', OCR_API_KEY);
    formData.append('language', 'jpn');
    formData.append('isOverlayRequired', 'false');
    formData.append('detectOrientation', 'true');
    formData.append('scale', 'true');
    formData.append('OCREngine', '2'); // より高精度なエンジン
    
    const response = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: {
        ...formData.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    
    console.log("OCR API レスポンス:", JSON.stringify(response.data, null, 2));
    
    if (response.data.IsErroredOnProcessing) {
      throw new Error(`OCRエラー: ${response.data.ErrorMessage}`);
    }
    
    if (!response.data.ParsedResults || response.data.ParsedResults.length === 0) {
      throw new Error('OCR結果が空です');
    }
    
    const text = response.data.ParsedResults[0].ParsedText;
    console.log("抽出されたテキスト:", text);
    
    // PayPayのレシートから情報を抽出
    return parsePayPayReceipt(text);
  } catch (error) {
    console.error('OCRエラー:', error);
    throw new Error(`OCR処理に失敗しました: ${error.message}`);
  }
}

// PayPayレシートのテキストを解析する関数
function parsePayPayReceipt(text) {
  console.log("PayPayレシート解析開始");
  
  let storeName = '不明';
  let amount = '0';
  let date = getCurrentDate();
  
  // 改行で分割
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  
  // 金額の抽出 (¥や円などの記号の近くの数字を探す)
  const amountRegex = /[\-¥￥][\s]*?([0-9,]+)/g;
  const amountMatches = [];
  let match;
  
  while ((match = amountRegex.exec(text)) !== null) {
    amountMatches.push(match[1].replace(/,/g, ''));
  }
  
  // 最も大きな金額を選択（支払い額と想定）
  if (amountMatches.length > 0) {
    amount = Math.max(...amountMatches.map(num => parseInt(num, 10))).toString();
  }
  
  // 店名を抽出（通常は最初の数行に含まれる）
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    // 店舗名と思われる行（数字やPayPayなどの特定ワードを含まない行）
    if (
      lines[i].length > 1 && 
      !/^[0-9¥￥\-]+$/.test(lines[i]) && 
      !lines[i].includes('PayPay') && 
      !lines[i].includes('paypay') &&
      !lines[i].includes('決済') &&
      !lines[i].includes('円')
    ) {
      storeName = lines[i];
      break;
    }
  }
  
  // 日付を抽出
  const dateRegex = /(\d{4}[年/\-]\d{1,2}[月/\-]\d{1,2}日?)|(\d{1,2}[月/\-]\d{1,2}日?)/;
  const dateMatch = text.match(dateRegex);
  
  if (dateMatch) {
    date = dateMatch[0].replace(/[年月]/g, '/').replace(/日/g, '');
    // 年が含まれていない場合は現在の年を追加
    if (!date.includes('/')) {
      const currentYear = new Date().getFullYear();
      date = `${currentYear}/${date}`;
    }
  }
  
  console.log(`抽出結果 - 店舗: ${storeName}, 金額: ${amount}, 日付: ${date}`);
  return { storeName, amount, date };
}

// 現在の日付を「YYYY/MM/DD」形式で取得
function getCurrentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

// Gemini APIを使用して支払いのカテゴリを判定する関数
async function categorizePayment(paymentData) {
  try {
    console.log("カテゴリ判定開始:", paymentData);
    
    const storeName = paymentData.storeName;
    const amount = paymentData.amount;
    
    // カテゴリの候補
    const categories = CATEGORIES;
    
    // Gemini APIへのプロンプト
    const prompt = `
以下の支払い情報に最も適したカテゴリを1つ選択してください。
店舗名: ${storeName}
金額: ${amount}円

選択可能なカテゴリ: ${categories.join(', ')}

最も適切なカテゴリのみを回答してください（理由は不要）。`;
    
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 50,
        },
      }
    );
    
    console.log("Gemini API レスポンス:", JSON.stringify(response.data, null, 2));
    
    // レスポンスからテキストを抽出
    let category = 'その他'; // デフォルト
    
    if (response.data && 
        response.data.candidates && 
        response.data.candidates[0] && 
        response.data.candidates[0].content && 
        response.data.candidates[0].content.parts && 
        response.data.candidates[0].content.parts[0] && 
        response.data.candidates[0].content.parts[0].text) {
      
      const responseText = response.data.candidates[0].content.parts[0].text.trim();
      
      // カテゴリリストと照合して最も近いものを選択
      for (const cat of categories) {
        if (responseText.includes(cat)) {
          category = cat;
          break;
        }
      }
    }
    
    console.log(`カテゴリ判定結果: ${category}`);
    return category;
  } catch (error) {
    console.error('カテゴリ判定エラー:', error);
    return 'その他'; // エラー時はデフォルトカテゴリを返す
  }
}

// Notionデータベースに新しいエントリを追加する関数
async function addToNotion(data, category) {
  console.log("Notionへのデータ追加開始:", data);
  
  try {
    // 日付文字列をISO形式に変換
    let dateValue;
    try {
      // YYYY/MM/DD形式の日付を解析
      const dateParts = data.date.split('/');
      if (dateParts.length === 3) {
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1; // JavaScriptの月は0始まり
        const day = parseInt(dateParts[2]);
        
        const dateObj = new Date(year, month, day);
        dateValue = dateObj.toISOString().split('T')[0];
      } else {
        // 形式が異なる場合は現在の日付を使用
        dateValue = new Date().toISOString().split('T')[0];
      }
    } catch (e) {
      console.error("日付解析エラー:", e);
      dateValue = new Date().toISOString().split('T')[0];
    }
    
    const response = await notion.pages.create({
      parent: {
        database_id: NOTION_DATABASE_ID,
      },
      properties: {
        'Name': {
          title: [
            {
              text: {
                content: data.storeName || '不明な店舗',
              },
            },
          ],
        },
        '金額': {
          number: parseInt(data.amount) || 0,
        },
        '日付': {
          date: {
            start: dateValue,
          },
        },
        'カテゴリ': {
          select: {
            name: category || 'その他',
          },
        },
      },
    });
    
    console.log("Notion追加成功:", response.id);
    return true;
  } catch (error) {
    console.error('Notion追加エラー:', error);
    return false;
  }
}

// Notionの既存ページを更新する関数
async function updateNotion(pageId, data, category) {
  console.log(`Notionページ更新開始: ${pageId}`, data);
  
  try {
    // 日付文字列をISO形式に変換
    let dateValue;
    try {
      // YYYY/MM/DD形式の日付を解析
      const dateParts = data.date.split('/');
      if (dateParts.length === 3) {
        const year = parseInt(dateParts[0]);
        const month = parseInt(dateParts[1]) - 1; // JavaScriptの月は0始まり
        const day = parseInt(dateParts[2]);
        
        const dateObj = new Date(year, month, day);
        dateValue = dateObj.toISOString().split('T')[0];
      } else {
        // 形式が異なる場合は現在の日付を使用
        dateValue = new Date().toISOString().split('T')[0];
      }
    } catch (e) {
      console.error("日付解析エラー:", e);
      dateValue = new Date().toISOString().split('T')[0];
    }
    
    const response = await notion.pages.update({
      page_id: pageId,
      properties: {
        'Name': {
          title: [
            {
              text: {
                content: data.storeName || '不明な店舗',
              },
            },
          ],
        },
        '金額': {
          number: parseInt(data.amount) || 0,
        },
        '日付': {
          date: {
            start: dateValue,
          },
        },
        'カテゴリ': {
          select: {
            name: category || 'その他',
          },
        },
      },
    });
    
    console.log("Notion更新成功:", response.id);
    return true;
  } catch (error) {
    console.error('Notion更新エラー:', error);
    return false;
  }
}

// アプリケーションの起動
app.listen(PORT, () => {
  console.log(`サーバーが起動しました: ポート ${PORT}`);
});

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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

async function handleEvent(event) {
  console.log("イベント処理開始:", JSON.stringify(event));
  
  if (event.type !== "message") {
    return Promise.resolve(null);
  }

  // テキストメッセージの処理
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
        
        // Notionに書き込み
        if (NOTION_DATABASE_ID) {
          console.log("Notionへの書き込みを開始します");
          await addToNotion(extractedData, category);
        } else {
          console.log("Notion DATABASE IDが設定されていないため、Notionへの書き込みをスキップします");
        }
        
        // 処理結果をプッシュメッセージで送信
        const userId = await getUserIdFromMessageId(messageId);
        if (userId) {
          await client.pushMessage(userId, {
            type: "text",
            text: `読み取り結果:\n店舗: ${extractedData.storeName}\n金額: ${extractedData.amount}円\n日付: ${extractedData.date}\n分類: ${category}\n\n${NOTION_DATABASE_ID ? "Notionに保存しました！" : "Notion連携は設定されていません"}`
          });
        } else {
          console.log("ユーザーIDが見つからないため、処理結果を送信できません");
        }
        
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
    console.error('非同期処理エラー:', error);
  }
}

// OCR.space APIを使用して画像からテキストを抽出
async function extractDataFromImage(imagePath) {
  try {
    const formData = new FormData();
    formData.append('language', 'jpn'); // 日本語
    formData.append('isOverlayRequired', 'false');
    formData.append('file', fs.createReadStream(imagePath));
    formData.append('OCREngine', '2'); // より高度なOCRエンジン
    
    console.log("OCR.space APIにリクエスト送信");
    const response = await axios.post('https://api.ocr.space/parse/image', formData, {
      headers: {
        ...formData.getHeaders(),
        'apikey': OCR_API_KEY,
      },
    });
    
    console.log("OCR.space API応答:", JSON.stringify(response.data, null, 2));
    
    if (!response.data || !response.data.ParsedResults || response.data.ParsedResults.length === 0) {
      throw new Error('OCR処理に失敗しました: ' + JSON.stringify(response.data));
    }
    
    const fullText = response.data.ParsedResults[0].ParsedText || '';
    console.log('抽出されたテキスト:', fullText);
    
    // PayPayの画面から情報を抽出するロジック
    const storeNameMatch = fullText.match(/支払い先[:：]\s*(.+?)(?:\n|$)/i) || 
                          fullText.match(/(.+?)に支払い/i) ||
                          fullText.match(/(.+?)\s*店舗/i) ||
                          fullText.match(/店舗名[:：]\s*(.+?)(?:\n|$)/i);
    
    const amountMatch = fullText.match(/([0-9,]+)円/i) || 
                        fullText.match(/支払金額[:：]\s*([0-9,]+)/i) ||
                        fullText.match(/金額[:：]\s*([0-9,]+)/i);
    
    const dateMatch = fullText.match(/(\d{4}[/-]\d{1,2}[/-]\d{1,2})/i) || 
                      fullText.match(/(\d{1,2}[/-]\d{1,2}\s+\d{1,2}:\d{2})/i) ||
                      fullText.match(/日時[:：]\s*(.+?)(?:\n|$)/i);
    
    const result = {
      storeName: storeNameMatch ? storeNameMatch[1].trim() : '不明',
      amount: amountMatch ? amountMatch[1].replace(/,/g, '') : '0',
      date: dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0],
      rawText: fullText
    };
    
    console.log("抽出結果:", result);
    return result;
  } catch (error) {
    console.error('テキスト抽出エラー:', error);
    return {
      storeName: '読み取りエラー',
      amount: '0',
      date: new Date().toISOString().split('T')[0],
      rawText: error.message
    };
  }
}

// 支払いのカテゴリを判定する関数
async function categorizePayment(extractedData) {
  try {
    if (GEMINI_API_KEY) {
      const prompt = `
      以下の支払い情報から、最も適切なカテゴリを以下の4つから一つだけ選んでください：
      「食品」「服飾」「学習」「その他」
      
      店舗名: ${extractedData.storeName}
      金額: ${extractedData.amount}円
      日付: ${extractedData.date}
      抽出テキスト: ${extractedData.rawText.substring(0, 200)}...
      
      カテゴリ名だけを返してください。
      `;
      
      console.log("Gemini APIにリクエスト送信");
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        }
      );
      
      console.log("Gemini API応答:", JSON.stringify(response.data, null, 2));
      
      // レスポンスからカテゴリを抽出
      const generatedText = response.data.candidates[0].content.parts[0].text;
      
      // カテゴリ文字列の抽出（「食品」「服飾」「学習」「その他」のいずれかを抽出）
      const categories = ['食品', '服飾', '学習', 'その他'];
      const category = categories.find(cat => generatedText.includes(cat)) || 'その他';
      
      return category;
    } else {
      console.log("Gemini APIキーがないため、簡易分類を使用します");
      return simpleCategorizeBySrore(extractedData.storeName);
    }
  } catch (error) {
    console.error('カテゴリ判定エラー:', error);
    // バックアップ処理 - 店舗名に基づく簡易分類
    return simpleCategorizeBySrore(extractedData.storeName);
  }
}

// 店舗名に基づく簡易分類
function simpleCategorizeBySrore(storeName) {
  const storeLower = storeName.toLowerCase();
  
  if (storeLower.includes('マート') || 
      storeLower.includes('スーパー') || 
      storeLower.includes('食品') || 
      storeLower.includes('レストラン') ||
      storeLower.includes('カフェ') ||
      storeLower.includes('食堂') ||
      storeLower.includes('コンビニ')) {
    return '食品';
  } else if (storeLower.includes('服') || 
             storeLower.includes('ファッション') ||
             storeLower.includes('アパレル') ||
             storeLower.includes('衣料')) {
    return '服飾';
  } else if (storeLower.includes('書店') || 
             storeLower.includes('大学') ||
             storeLower.includes('学校') || 
             storeLower.includes('塾') ||
             storeLower.includes('本') ||
             storeLower.includes('セミナー')) {
    return '学習';
  }
  return 'その他';
}

// Notionデータベースに情報を追加する関数（重複チェック機能付き）
async function addToNotion(extractedData, category) {
    try {
      if (!NOTION_DATABASE_ID) {
        console.log("Notion DATABASE IDが設定されていないため、追加をスキップします");
        return false;
      }
      
      // 同じデータが既に存在するか確認
      const existingEntries = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          and: [
            {
              property: "名前",
              title: {
                equals: extractedData.storeName
              }
            },
            {
              property: "金額",
              number: {
                equals: parseInt(extractedData.amount, 10) || 0
              }
            },
            {
              property: "日付",
              date: {
                equals: extractedData.date
              }
            }
          ]
        }
      });
      
      // 既に存在する場合はスキップ
      if (existingEntries.results.length > 0) {
        console.log('同じデータが既に存在します。追加をスキップします。');
        return true;
      }
      
      console.log("Notion APIにリクエスト送信");
      await notion.pages.create({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          名前: {
            title: [
              {
                text: {
                  content: extractedData.storeName
                }
              }
            ]
          },
          金額: {
            number: parseInt(extractedData.amount, 10) || 0
          },
          日付: {
            date: {
              start: extractedData.date
            }
          },
          カテゴリ: {
            select: {
              name: category
            }
          }
        }
      });
      
      console.log('Notionに追加しました');
      return true;
    } catch (error) {
      console.error('Notion追加エラー:', error);
      return false;
    }
  }

app.listen(PORT, () => {
  console.log(`Server running at port ${PORT}`);
});

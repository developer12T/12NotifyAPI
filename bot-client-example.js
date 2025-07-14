// ตัวอย่าง Node.js client สำหรับ bot
const axios = require('axios');

// Bot configuration
const BOT_EMPLOYEE_ID = '20250007';
const API_BASE_URL = 'http://localhost:8006';

// Simulate bot getting FCM token from Firebase SDK
async function getBotFcmToken() {
  // ในความเป็นจริง bot จะขอ token จาก Firebase SDK
  // ตัวอย่าง: const token = await firebase.messaging().getToken();
  
  // สำหรับตัวอย่างนี้เราจะ simulate token
  const simulatedToken = `real_fcm_token_${BOT_EMPLOYEE_ID}_${Date.now()}`;
  return simulatedToken;
}

// Send FCM token to backend
async function updateBotToken() {
  try {
    const fcmToken = await getBotFcmToken();
    
    const response = await axios.post(`${API_BASE_URL}/api/users/update-bot-token`, {
      employeeID: BOT_EMPLOYEE_ID,
      fcmToken: fcmToken,
      deviceInfo: {
        platform: 'nodejs-service',
        appVersion: '1.0.0',
        deviceModel: 'Bot Service'
      }
    });
    
    console.log('Bot token updated successfully:', response.data);
    return fcmToken;
  } catch (error) {
    console.error('Error updating bot token:', error.response?.data || error.message);
  }
}

// Get bot token from backend
async function getBotToken() {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/users/bot-token/${BOT_EMPLOYEE_ID}`);
    console.log('Bot token retrieved:', response.data);
    return response.data.data.fcmToken;
  } catch (error) {
    console.error('Error getting bot token:', error.response?.data || error.message);
  }
}

// Main function
async function main() {
  console.log('Bot client starting...');
  
  // Update bot token
  await updateBotToken();
  
  // Get bot token
  await getBotToken();
  
  console.log('Bot client ready!');
}

// Run bot client
main().catch(console.error); 
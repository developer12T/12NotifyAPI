const admin = require('firebase-admin');

// Initialize Firebase Admin if not already initialized
let isInitialized = false;

const initializeFCM = () => {
  if (isInitialized) {
    return;
  }

  try {
    // Check if Firebase is already initialized
    if (admin.apps.length === 0) {
      // Try to load service account from environment or file
      let serviceAccount;
      
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Parse service account from environment variable
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      } else {
        // Try to load from file
        try {
          serviceAccount = require('../../serviceAccountKey.json');
        } catch (error) {
          console.error('Firebase service account not found. Please provide FIREBASE_SERVICE_ACCOUNT environment variable or serviceAccountKey.json file.');
          return;
        }
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    
    isInitialized = true;
    console.log('Firebase Admin SDK initialized successfully');
  } catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
  }
};

// Send notification to single device
const sendNotification = async (token, title, body, data = {}) => {
  try {
    initializeFCM();
    
    if (!isInitialized) {
      throw new Error('Firebase Admin SDK not initialized');
    }

    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: data,
      token: token,
      android: {
        priority: 'high',
        notification: {
          channelId: 'high_importance_channel',
          priority: 'high',
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    return { success: true, messageId: response };
  } catch (error) {
    console.error('Error sending notification:', error);
    return { success: false, error: error.message };
  }
};

// Send notification to multiple devices
const sendMulticastNotification = async (tokens, title, body, data = {}) => {
  try {
    initializeFCM();
    
    if (!isInitialized) {
      throw new Error('Firebase Admin SDK not initialized');
    }

    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: data,
      tokens: tokens, // array of tokens
    };

    const response = await admin.messaging().sendMulticast(message);
    return { 
      success: true, 
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses
    };
  } catch (error) {
    console.error('Error sending multicast notification:', error);
    return { success: false, error: error.message };
  }
};

// Test notification function
const sendTestNotification = async (token) => {
  const testData = {
    type: 'test',
    timestamp: new Date().toISOString(),
    message: 'This is a test notification from 12NotifyAPI'
  };

  return await sendNotification(
    token,
    'Test Notification',
    'This is a test notification from your 12NotifyAPI server',
    testData
  );
};

module.exports = {
  initializeFCM,
  sendNotification,
  sendMulticastNotification,
  sendTestNotification
}; 
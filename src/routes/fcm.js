const express = require('express');
const router = express.Router();
const { 
  sendNotification, 
  sendMulticastNotification, 
  sendTestNotification 
} = require('../services/fcmService');

// API สำหรับส่ง notification ไปยังอุปกรณ์เดียว
router.post('/send-notification', async (req, res) => {
  try {
    const { token, title, body, data } = req.body;

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token is required' 
      });
    }

    if (!title || !body) {
      return res.status(400).json({ 
        success: false, 
        error: 'Title and body are required' 
      });
    }

    const result = await sendNotification(token, title, body, data);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Error in send-notification endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API สำหรับส่ง notification ไปยังหลายอุปกรณ์
router.post('/send-to-multiple', async (req, res) => {
  try {
    const { tokens, title, body, data } = req.body;

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Tokens array is required and must not be empty' 
      });
    }

    if (!title || !body) {
      return res.status(400).json({ 
        success: false, 
        error: 'Title and body are required' 
      });
    }

    const result = await sendMulticastNotification(tokens, title, body, data);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    console.error('Error in send-to-multiple endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// API สำหรับ test notification
router.post('/test-notification', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token is required for test notification' 
      });
    }

    console.log('Sending test notification to token:', token);
    
    const result = await sendTestNotification(token);
    
    if (result.success) {
      console.log('Test notification sent successfully:', result.messageId);
      res.json({
        success: true,
        message: 'Test notification sent successfully',
        messageId: result.messageId,
        timestamp: new Date().toISOString()
      });
    } else {
      console.error('Test notification failed:', result.error);
      res.status(500).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error in test-notification endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// GET endpoint สำหรับ test notification (สำหรับทดสอบง่ายๆ)
router.get('/test-notification/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        error: 'Token is required for test notification' 
      });
    }

    console.log('Sending test notification to token:', token);
    
    const result = await sendTestNotification(token);
    
    if (result.success) {
      console.log('Test notification sent successfully:', result.messageId);
      res.json({
        success: true,
        message: 'Test notification sent successfully',
        messageId: result.messageId,
        timestamp: new Date().toISOString()
      });
    } else {
      console.error('Test notification failed:', result.error);
      res.status(500).json({
        success: false,
        error: result.error,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error in test-notification GET endpoint:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Simple test notification (single token)
router.post('/test-single', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token is required'
      });
    }

    const admin = require('firebase-admin');
    const messaging = admin.messaging();

    const message = {
      notification: {
        title: 'Test Notification',
        body: 'This is a test notification from 12NotifyAPI'
      },
      data: {
        type: 'test',
        timestamp: new Date().toISOString()
      },
      token: token
    };

    console.log('Sending test notification to token:', token.substring(0, 20) + '...');
    
    const response = await messaging.send(message);
    
    console.log('Test notification sent successfully:', response);
    
    res.json({
      success: true,
      message: 'Test notification sent successfully',
      messageId: response
    });

  } catch (error) {
    console.error('Test notification error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code
    });
  }
});

// Test Firebase configuration
router.get('/test-config', async (req, res) => {
  try {
    const admin = require('firebase-admin');
    
    // ตรวจสอบ Firebase apps
    const apps = admin.apps;
    console.log('Firebase apps:', apps.length);
    
    // ตรวจสอบ project ID
    const projectId = admin.app().options.projectId;
    console.log('Project ID:', projectId);
    
    // ทดสอบ messaging service
    const messaging = admin.messaging();
    console.log('Messaging service initialized');
    
    res.json({
      success: true,
      message: 'Firebase configuration is correct',
      projectId: projectId,
      appsCount: apps.length
    });
  } catch (error) {
    console.error('Firebase config test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router; 
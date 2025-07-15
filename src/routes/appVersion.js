const express = require('express');
const router = express.Router();
const AppVersion = require('../models/AppVersion');

// GET /api/app_version
// Returns app version information for Flutter app
router.get('/app_version', async (req, res) => {
  try {
    // Get the latest version info from database
    let versionInfo = await AppVersion.findOne().sort({ updated_at: -1 });
    
    // If no version info exists, create default one
    if (!versionInfo) {
      versionInfo = new AppVersion({
        min_version: process.env.APP_MIN_VERSION || "1.0.2",
        latest_version: process.env.APP_LATEST_VERSION || "1.2.3",
        update_url: process.env.APP_UPDATE_URL || "https://yourdomain.com/app-latest.apk"
      });
      await versionInfo.save(); 
    }

    // Return the version info in the format expected by Flutter
    const response = {
      min_version: versionInfo.min_version,
      latest_version: versionInfo.latest_version,
      update_url: versionInfo.update_url
    };

    res.status(200).json({
      statusCode: 200,
      message: "App version information retrieved successfully2",
      data: response
    });

  } catch (error) {
    console.error('App Version Error:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลเวอร์ชันแอป',
      error: error.message
    });
  }
});

// PUT /api/app_version
// Update app version information (Admin only)
router.put('/app_version', async (req, res) => {
  try {
    const { min_version, latest_version, update_url, platform, force_update, update_message } = req.body;

    // Validate required fields
    if (!min_version || !latest_version || !update_url) {
      return res.status(400).json({
        statusCode: 400,
        message: 'กรุณากรอกข้อมูลที่จำเป็น (min_version, latest_version, update_url)'
      });
    }

    // Get the latest version info or create new one
    let versionInfo = await AppVersion.findOne().sort({ updated_at: -1 });
    
    if (!versionInfo) {
      versionInfo = new AppVersion();
    }

    // Update the version info
    versionInfo.min_version = min_version;
    versionInfo.latest_version = latest_version;
    versionInfo.update_url = update_url;
    
    if (platform) versionInfo.platform = platform;
    if (force_update !== undefined) versionInfo.force_update = force_update;
    if (update_message) versionInfo.update_message = update_message;

    await versionInfo.save();

    res.status(200).json({
      statusCode: 200,
      message: "อัปเดตข้อมูลเวอร์ชันแอปสำเร็จ",
      data: {
        min_version: versionInfo.min_version,
        latest_version: versionInfo.latest_version,
        update_url: versionInfo.update_url,
        platform: versionInfo.platform,
        force_update: versionInfo.force_update,
        update_message: versionInfo.update_message,
        updated_at: versionInfo.updated_at
      }
    });

  } catch (error) {
    console.error('Update App Version Error:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัปเดตข้อมูลเวอร์ชันแอป',
      error: error.message
    });
  }
});

// GET /api/app_version/admin
// Get detailed version information for admin (includes all fields)
router.get('/app_version/admin', async (req, res) => {
  try {
    const versionInfo = await AppVersion.findOne().sort({ updated_at: -1 });
    
    if (!versionInfo) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลเวอร์ชันแอป'
      });
    }

    res.status(200).json({
      statusCode: 200,
      message: "ดึงข้อมูลเวอร์ชันแอปสำเร็จ",
      data: {
        min_version: versionInfo.min_version,
        latest_version: versionInfo.latest_version,
        update_url: versionInfo.update_url,
        platform: versionInfo.platform,
        force_update: versionInfo.force_update,
        update_message: versionInfo.update_message,
        created_at: versionInfo.created_at,
        updated_at: versionInfo.updated_at
      }
    });

  } catch (error) {
    console.error('Get App Version Admin Error:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลเวอร์ชันแอป',
      error: error.message
    });
  }
});

module.exports = router; 
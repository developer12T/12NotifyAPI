const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Bot = require('../models/Bot');
const Room = require('../models/Room');
const { readAllLDAP,readLDAP } = require('../services/ldapServices');
// const bcrypt = require('bcryptjs');

// Get all users
router.get('/', async (req, res) => {
  try {
    const result = await readLDAP();

    if (result.success) {
      // Add role to each entry
      const entriesWithRole = await Promise.all(result.entries.map(async (entry) => {
        const user = await User.findOne({ employeeID: entry.employeeID });
        return {
          ...entry,
          role: user ? user.role : 'user'  // Use role from DB if exists, otherwise 'user'
        };
      }));

      return res.status(200).json({ 
        statusCode: 200,
        count: entriesWithRole.length, 
        data: entriesWithRole
      });
    } else {
      res.status(401).json({ statusCode: 401, message: 'เข้าสู่ระบบไม่สำเร็จ' });
    }

  } catch (error) {
    console.error('LDAP Login Error:', error);
    res.status(500).json({ 
      message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ',
      error: error.message,
      details: error.lde_message || 'ไม่พบรายละเอียดเพิ่มเติม'
    });
  }
});

// Get all bots
router.get('/getBot', async (req, res) => {
  try {
    // Find all users with role 'bot'
    const bots = await User.find({ role: 'bot' });
    
    // Get all bot details
    const botDetails = await Bot.find({
      employeeID: { $in: bots.map(bot => bot.employeeID) }
    });

    // Create a map of bot details for easy lookup
    const botDetailsMap = botDetails.reduce((map, bot) => {
      map[bot.employeeID] = bot;
      return map;
    }, {});

    // Format the response
    const formattedBots = bots.map(bot => ({
      employeeID: bot.employeeID,
      role: bot.role,
      botDetails: botDetailsMap[bot.employeeID] || null
    }));

    return res.status(200).json({
      statusCode: 200,
      count: formattedBots.length,
      data: formattedBots
    });

  } catch (error) {
    console.error('Error fetching bots:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลบอท',
      error: error.message
    });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('rooms');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user's rooms
router.get('/:id/rooms', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Find all rooms where the user is either a member or admin
    const rooms = await Room.find({
      $or: [
        { members: user._id },
        { admin: user._id }
      ]
    }).populate('members', 'username')
      .populate('admin', 'username');

    // Format rooms with basic details
    const formattedRooms = rooms.map(room => {
      const adminMember = room.members.find(member => member.role === 'admin');
      return {
        id: room._id,
        name: room.name,
        description: room.description,
        color: room.color,
        admin: adminMember ? {
          employeeID: adminMember.empId,
          role: adminMember.role
        } : null,
        memberCount: room.members.length,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      };
    });

    res.json(formattedRooms);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new user
router.post('/create', async (req, res) => {
  try {
    const { employeeID, role } = req.body;

    if (!employeeID) {
      return res.status(400).json({
        statusCode: 400,
        message: 'employeeID is required'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ employeeID });
    if (existingUser) {
      return res.status(409).json({
        statusCode: 409,
        message: 'User already exists',
        data: {
          employeeID: existingUser.employeeID,
          role: existingUser.role
        }
      });
    }
 
    // Create new user
    const newUser = new User({
      employeeID,
      role: role || 'user'  // Default role is 'user' if not specified
    });

    await newUser.save();

    res.status(201).json({
      statusCode: 201,
      message: 'User created successfully',
      data: {
        employeeID: newUser.employeeID,
        role: newUser.role
      }
    });

  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการสร้างผู้ใช้',
      error: error.message 
    });
  }
});

// Update user role
router.post('/update', async (req, res) => {
  try {
    const { employeeID, role } = req.body;

    if (!employeeID || !role) {
      return res.status(400).json({
        statusCode: 400,
        message: 'employeeID and role are required'
      });
    }

    // Check if user exists
    const existingUser = await User.findOne({ employeeID });
    if (!existingUser) {
      return res.status(404).json({
        statusCode: 404,
        message: 'User not found'
      });
    }

    // Update role
    existingUser.role = role;
    await existingUser.save();

    return res.json({
      statusCode: 200,
      message: 'User role updated successfully',
      data: {
        employeeID: existingUser.employeeID,
        role: existingUser.role,
        updatedAt: existingUser.updatedAt
      }
    });

  } catch (error) {
    console.error('Error updating user role:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดท role',
      error: error.message 
    });
  }
});

// Create new bot
router.post('/create-bot', async (req, res) => {
  try {
    const { name, roomCount, requestCount, createdBy, room } = req.body;
    
    if (!name) {
      return res.status(400).json({
        statusCode: 400,
        message: 'name is required'
      });
    }

    // Get current year
    const currentYear = new Date().getFullYear();
    
    // Find the latest bot with employeeID starting with current year
    const latestBot = await Bot.findOne({
      employeeID: new RegExp(`^${currentYear}`)
    }).sort({ employeeID: -1 });

    let newEmployeeID;
    if (latestBot) {
      // Extract the number part and increment
      const currentNumber = parseInt(latestBot.employeeID.slice(4));
      newEmployeeID = `${currentYear}${String(currentNumber + 1).padStart(4, '0')}`;
    } else {
      // If no bot exists for current year, start with 0001
      newEmployeeID = `${currentYear}0001`;
    }

    // Check if user already exists with this ID
    const existingBot = await Bot.findOne({ employeeID: newEmployeeID });
    if (existingBot) {
      return res.status(409).json({
        statusCode: 409,
        message: 'Bot already exists',
        data: {
          employeeID: existingBot.employeeID,
          name: existingBot.name,
          roomCount: existingBot.roomCount,
          requestCount: existingBot.requestCount
        }
      });
    }
 
    // สร้าง FCM token จริงสำหรับ bot
    let botFcmToken = null;
    try {
      // ใช้ Firebase Admin SDK สร้าง FCM token จริง
      const admin = require('firebase-admin');
      if (admin.apps.length > 0) {
        // สร้าง FCM token จริงสำหรับ bot
        const messaging = admin.messaging();
        // สร้าง device token registration สำหรับ bot
        botFcmToken = await messaging.getToken({
          topic: `bot_${newEmployeeID}`,
          data: {
            employeeID: newEmployeeID,
            role: 'bot',
            name: name
          }
        });
        console.log(`[Bot Creation] Generated real FCM token for bot ${newEmployeeID}: ${botFcmToken.substring(0, 20)}...`);
      } else {
        // Fallback: สร้าง simulated token ถ้า Firebase ไม่พร้อม
        botFcmToken = `bot_${newEmployeeID}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        console.log(`[Bot Creation] Generated simulated token for bot ${newEmployeeID}: ${botFcmToken.substring(0, 20)}...`);
      }
    } catch (tokenError) {
      console.log(`[Bot Creation] Could not generate FCM token for bot ${newEmployeeID}:`, tokenError.message);
      // Fallback: สร้าง simulated token
      botFcmToken = `bot_${newEmployeeID}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    // Create new bot
    const newBot = new Bot({
      employeeID: newEmployeeID,
      name,
      roomCount: roomCount || 0,
      requestCount: requestCount || 0,
      createdBy,
      fcmToken: botFcmToken,
      deviceInfo: {
        platform: 'nodejs-service',
        appVersion: '1.0.0',
        deviceModel: 'Bot Service'
      },
      lastTokenUpdate: new Date()
    });

    // Create new user with bot role
    const newUser = new User({
      employeeID: newEmployeeID,
      role: 'bot',
      fcmToken: botFcmToken,
      deviceInfo: {
        platform: 'nodejs-service',
        appVersion: '1.0.0',
        deviceModel: 'Bot Service'
      },
      lastTokenUpdate: new Date()
    });

    // Save both bot and user
    await newBot.save();
    await newUser.save();

    // Add bot to specified rooms if room array is provided
    if (room && Array.isArray(room) && room.length > 0) {
      try {
        // Create member object with required fields
        const memberData = {
          _id: newUser._id,
          empId: newEmployeeID,
          role: 'bot'
        };

        // Add bot to all specified rooms with member data
        await Room.updateMany(
          { _id: { $in: room } },
          { $addToSet: { members: memberData } }
        );

        // Update bot's roomCount
        newBot.roomCount = room.length;
        await newBot.save();
      } catch (roomError) {
        console.error('Error adding bot to rooms:', roomError);
        // Continue with the response even if room addition fails
      }
    }

    res.status(201).json({
      statusCode: 201,
      message: 'Bot created successfully',
      data: {
        employeeID: newBot.employeeID,
        name: newBot.name,
        roomCount: newBot.roomCount,
        requestCount: newBot.requestCount,
        rooms: room || []
      }
    });

  } catch (error) {
    console.error('Error creating bot:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการสร้างบอท',
      error: error.message 
    });
  }
});

// Get bots by creator
router.get('/getBotByUser/:createdBy', async (req, res) => {
  try {
    const { createdBy } = req.params;

    if (!createdBy) {
      return res.status(400).json({
        statusCode: 400,
        message: 'createdBy parameter is required'
      });
    }

    // Find all bots created by the specified user
    const botDetails = await Bot.find();
    
    // Get all users with role 'bot' that match these bots
    const bots = await User.find({
      role: 'bot',
      employeeID: { $in: botDetails.map(bot => bot.employeeID) }
    });

    // Create a map of bot details for easy lookup
    const botDetailsMap = botDetails.reduce((map, bot) => {
      map[bot.employeeID] = bot;
      return map;
    }, {});

    // Format the response
    const formattedBots = bots.map(bot => ({
      employeeID: bot.employeeID,
      role: bot.role,
      botDetails: botDetailsMap[bot.employeeID] || null
    }));

    return res.status(200).json({
      statusCode: 200,
      count: formattedBots.length,
      data: formattedBots,
      createdBy: createdBy
    });

  } catch (error) {
    console.error('Error fetching bots by user:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลบอทของผู้ใช้',
      error: error.message
    });
  }
});

// Get bot details with rooms
router.get('/bot/:employeeID', async (req, res) => {
  try {
    const { employeeID } = req.params;

    if (!employeeID) {
      return res.status(400).json({
        statusCode: 400,
        message: 'employeeID parameter is required'
      });
    }

    // Find bot details from Bot model
    const botDetails = await Bot.findOne({ employeeID });
    if (!botDetails) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท'
      });
    }

    // Find all rooms where this bot is a member
    const rooms = await Room.find({
      'members.empId': employeeID
    });

    // Get creator details
    const creatorResult = await User.findOne({ employeeID: botDetails.createdBy });
    const creatorDetails = creatorResult ? {
      employeeID: creatorResult.employeeID,
      role: creatorResult.role
    } : null;

    // Format rooms with basic details
    const formattedRooms = rooms.map(room => {
      const adminMember = room.members.find(member => member.role === 'admin');
      return {
        id: room._id,
        name: room.name,
        description: room.description,
        color: room.color,
        admin: adminMember ? {
          employeeID: adminMember.empId,
          role: adminMember.role
        } : null,
        memberCount: room.members.length,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      };
    });

    // Format bot details with rooms
    const formattedBot = {
      employeeID: botDetails.employeeID,
      role: 'bot',
      botDetails: {
        name: botDetails.name,
        roomCount: botDetails.roomCount,
        requestCount: botDetails.requestCount,
        createdBy: creatorDetails,
        createdAt: botDetails.createdAt,
        updatedAt: botDetails.updatedAt
      },
      rooms: formattedRooms
    };

    return res.status(200).json({
      statusCode: 200,
      data: formattedBot
    });

  } catch (error) {
    console.error('Error fetching bot details:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลบอท',
      error: error.message
    });
  }
});

// Update bot details
router.put('/update-bot', async (req, res) => {
  try {
    const { employeeID, name, requestCount, room } = req.body;

    if (!employeeID) {
      return res.status(400).json({
        statusCode: 400,
        message: 'employeeID is required'
      });
    }

    // Find bot details
    const bot = await Bot.findOne({ employeeID });
    if (!bot) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท'
      });
    }

    // Find bot user
    const botUser = await User.findOne({ employeeID, role: 'bot' });
    if (!botUser) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลผู้ใช้ของบอท'
      });
    }

    // Prepare update data for bot details
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (requestCount !== undefined) updateData.requestCount = requestCount;
    updateData.updatedAt = new Date();

    // Handle room updates if provided
    if (room && Array.isArray(room)) {
      try {
        // Create member data for the bot
        const memberData = {
          _id: botUser._id,
          empId: employeeID,
          role: 'bot'
        };

        // Remove bot from all current rooms
        await Room.updateMany(
          { 'members.empId': employeeID },
          { $pull: { members: { empId: employeeID } } }
        );

        // Add bot to new rooms if any
        if (room.length > 0) {
          await Room.updateMany(
            { _id: { $in: room } },
            { $addToSet: { members: memberData } }
          );
        }

        // Update roomCount
        updateData.roomCount = room.length;
      } catch (roomError) {
        console.error('Error updating bot rooms:', roomError);
        // Continue with the response even if room update fails
      }
    }

    // Update bot details
    const updatedBot = await Bot.findOneAndUpdate(
      { employeeID },
      { $set: updateData },
      { new: true }
    );

    // Get creator details
    const creatorResult = await User.findOne({ employeeID: updatedBot.createdBy });
    const creatorDetails = creatorResult ? {
      employeeID: creatorResult.employeeID,
      role: creatorResult.role
    } : null;

    // Get updated room details
    const updatedRooms = await Room.find({
      'members.empId': employeeID
    });

    // Format rooms with basic details
    const formattedRooms = updatedRooms.map(room => {
      const adminMember = room.members.find(member => member.role === 'admin');
      return {
        id: room._id,
        name: room.name,
        description: room.description,
        color: room.color,
        admin: adminMember ? {
          employeeID: adminMember.empId,
          role: adminMember.role
        } : null,
        memberCount: room.members.length,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      };
    });

    // Format response
    const formattedBot = {
      employeeID: updatedBot.employeeID,
      role: 'bot',
      botDetails: {
        name: updatedBot.name,
        roomCount: updatedBot.roomCount,
        requestCount: updatedBot.requestCount,
        createdBy: creatorDetails,
        createdAt: updatedBot.createdAt,
        updatedAt: updatedBot.updatedAt
      },
      rooms: formattedRooms
    };

    return res.status(200).json({
      statusCode: 200,
      message: 'อัพเดทข้อมูลบอทสำเร็จ',
      data: formattedBot
    });

  } catch (error) {
    console.error('Error updating bot:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดทข้อมูลบอท',
      error: error.message
    });
  }
});

// Delete bot
router.delete('/delete-bot', async (req, res) => {
  try {
    const { employeeID } = req.body;

    if (!employeeID) {
      return res.status(400).json({
        statusCode: 400,
        message: 'employeeID is required'
      });
    }

    // Find bot details
    const bot = await Bot.findOne({ employeeID });
    if (!bot) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท'
      });
    }

    // Find bot user
    const botUser = await User.findOne({ employeeID, role: 'bot' });
    if (!botUser) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลผู้ใช้ของบอท'
      });
    }

    try {
      // Remove bot from all rooms
      await Room.updateMany(
        { 'members.empId': employeeID },
        { $pull: { members: { empId: employeeID } } }
      );

      // Delete bot user
      await User.deleteOne({ _id: botUser._id });

      // Delete bot details
      await Bot.deleteOne({ _id: bot._id });

      return res.status(200).json({
        statusCode: 200,
        message: 'ลบบอทสำเร็จ',
        data: {
          employeeID: bot.employeeID,
          name: bot.name,
          deletedAt: new Date()
        }
      });

    } catch (deleteError) {
      console.error('Error deleting bot:', deleteError);
      throw new Error('เกิดข้อผิดพลาดในการลบข้อมูลบอท');
    }

  } catch (error) {
    console.error('Error in delete-bot:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการลบบอท',
      error: error.message
    });
  }
});

// Update FCM Token (สำหรับ Flutter app)
router.post('/fcm-token', async (req, res) => {
  try {
    const { user_id, fcm_token, platform, app_version } = req.body;

    if (!user_id || !fcm_token) {
      return res.status(400).json({
        statusCode: 400,
        message: 'User ID and FCM token are required'
      });
    }

    // อัพเดท user record
    const user = await User.findOneAndUpdate(
      { employeeID: user_id },
      {
        fcmToken: fcm_token,
        deviceInfo: {
          platform: platform || 'android',
          appVersion: app_version || '1.0.0'
        },
        lastTokenUpdate: new Date()
      },
      { 
        new: true 
      }
    );

    if (!user) {
      return res.status(404).json({
        statusCode: 404,
        message: 'User not found'
      });
    }

    console.log(`[FCM Token] Updated for user ${user_id}:`, {
      token: fcm_token.substring(0, 20) + '...',
      platform,
      appVersion: app_version
    });

    res.json({
      statusCode: 200,
      message: 'FCM token updated successfully',
      data: {
        employeeID: user.employeeID,
        lastTokenUpdate: user.lastTokenUpdate
      }
    });

  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดท FCM token',
      error: error.message
    });
  }
});

// Update FCM Token (สำหรับ API เรียกโดยตรง)
router.post('/update-fcm-token', async (req, res) => {
  try {
    const { employeeID, fcmToken, deviceInfo } = req.body;

    if (!employeeID || !fcmToken) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Employee ID and FCM token are required'
      });
    }

    // อัพเดทหรือสร้าง user record
    const user = await User.findOneAndUpdate(
      { employeeID },
      {
        fcmToken,
        deviceInfo: deviceInfo || {},
        lastTokenUpdate: new Date()
      },
      { 
        upsert: true, // สร้างใหม่ถ้าไม่มี
        new: true 
      }
    );

    console.log(`[FCM Token] Updated for user ${employeeID}:`, {
      token: fcmToken.substring(0, 20) + '...',
      deviceInfo
    });

    res.json({
      statusCode: 200,
      message: 'FCM token updated successfully',
      data: {
        employeeID: user.employeeID,
        lastTokenUpdate: user.lastTokenUpdate
      }
    });

  } catch (error) {
    console.error('Error updating FCM token:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดท FCM token',
      error: error.message
    });
  }
});

// Get all FCM tokens (for admin)
router.get('/fcm-tokens', async (req, res) => {
  try {
    const { employeeID } = req.query;
    
    // ตรวจสอบว่าเป็น admin
    const adminUser = await User.findOne({ employeeID, role: 'admin' });
    if (!adminUser) {
      return res.status(403).json({
        statusCode: 403,
        message: 'เฉพาะ admin เท่านั้นที่สามารถดู FCM tokens ได้'
      });
    }

    const users = await User.find({ fcmToken: { $exists: true, $ne: null } })
      .select('employeeID fcmToken deviceInfo lastTokenUpdate')
      .sort({ lastTokenUpdate: -1 });

    res.json({
      statusCode: 200,
      tokens: users.map(user => ({
        employeeID: user.employeeID,
        fcmToken: user.fcmToken,
        deviceInfo: user.deviceInfo,
        lastTokenUpdate: user.lastTokenUpdate
      }))
    });

  } catch (error) {
    console.error('Error getting FCM tokens:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึง FCM tokens',
      error: error.message
    });
  }
});

// Get bot FCM token
router.get('/bot-token/:employeeID', async (req, res) => {
  try {
    const { employeeID } = req.params;

    if (!employeeID) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Employee ID is required'
      });
    }

    // ตรวจสอบว่าเป็น bot หรือไม่
    const bot = await Bot.findOne({ employeeID });
    if (!bot) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท'
      });
    }

    // ดึง token จาก Bot model
    const botToken = await Bot.findOne({ employeeID }).select('fcmToken deviceInfo lastTokenUpdate');
    
    if (!botToken || !botToken.fcmToken) {
      return res.status(404).json({
        statusCode: 404,
        message: 'บอทไม่มี FCM token',
        data: {
          employeeID: employeeID,
          hasToken: false
        }
      });
    }

    console.log(`[Bot Token] Retrieved token for bot ${employeeID}:`, {
      token: botToken.fcmToken.substring(0, 20) + '...',
      lastUpdate: botToken.lastTokenUpdate
    });

    res.json({
      statusCode: 200,
      message: 'ดึง FCM token ของบอทสำเร็จ',
      data: {
        employeeID: employeeID,
        fcmToken: botToken.fcmToken,
        deviceInfo: botToken.deviceInfo,
        lastTokenUpdate: botToken.lastTokenUpdate,
        hasToken: true
      }
    });

  } catch (error) {
    console.error('Error getting bot token:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึง FCM token ของบอท',
      error: error.message
    });
  }
});

// Update bot FCM token
router.post('/update-bot-token', async (req, res) => {
  try {
    const { employeeID, fcmToken, deviceInfo } = req.body;

    if (!employeeID || !fcmToken) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Employee ID and FCM token are required'
      });
    }

    // ตรวจสอบว่าเป็น bot หรือไม่
    const bot = await Bot.findOne({ employeeID });
    if (!bot) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท'
      });
    }

    // อัพเดท token ใน Bot model
    const updatedBot = await Bot.findOneAndUpdate(
      { employeeID },
      {
        fcmToken,
        deviceInfo: deviceInfo || {
          platform: 'nodejs-service',
          appVersion: '1.0.0',
          deviceModel: 'Bot Service'
        },
        lastTokenUpdate: new Date()
      },
      { new: true }
    );

    // อัพเดท token ใน User model ด้วย (ถ้ามี)
    await User.findOneAndUpdate(
      { employeeID, role: 'bot' },
      {
        fcmToken,
        deviceInfo: deviceInfo || {
          platform: 'nodejs-service',
          appVersion: '1.0.0',
          deviceModel: 'Bot Service'
        },
        lastTokenUpdate: new Date()
      }
    );

    console.log(`[Bot Token] Updated token for bot ${employeeID}:`, {
      token: fcmToken.substring(0, 20) + '...',
      deviceInfo: deviceInfo
    });

    res.json({
      statusCode: 200,
      message: 'อัพเดท FCM token ของบอทสำเร็จ',
      data: {
        employeeID: employeeID,
        lastTokenUpdate: updatedBot.lastTokenUpdate,
        deviceInfo: updatedBot.deviceInfo
      }
    });

  } catch (error) {
    console.error('Error updating bot token:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดท FCM token ของบอท',
      error: error.message
    });
  }
});

// Get all bot tokens (for admin)
router.get('/bot-tokens', async (req, res) => {
  try {
    const { employeeID } = req.query;
    
    // ตรวจสอบว่าเป็น admin
    const adminUser = await User.findOne({ employeeID, role: 'admin' });
    if (!adminUser) {
      return res.status(403).json({
        statusCode: 403,
        message: 'เฉพาะ admin เท่านั้นที่สามารถดู FCM tokens ของบอทได้'
      });
    }

    const botsWithTokens = await Bot.find({ 
      fcmToken: { $exists: true, $ne: null } 
    }).select('employeeID fcmToken deviceInfo lastTokenUpdate name')
      .sort({ lastTokenUpdate: -1 });

    res.json({
      statusCode: 200,
      message: 'ดึง FCM tokens ของบอททั้งหมดสำเร็จ',
      data: {
        totalBots: botsWithTokens.length,
        bots: botsWithTokens.map(bot => ({
          employeeID: bot.employeeID,
          name: bot.name,
          fcmToken: bot.fcmToken,
          deviceInfo: bot.deviceInfo,
          lastTokenUpdate: bot.lastTokenUpdate
        }))
      }
    });

  } catch (error) {
    console.error('Error getting bot tokens:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึง FCM tokens ของบอท',
      error: error.message
    });
  }
});

// Generate FCM token for existing bot
router.post('/generate-bot-token', async (req, res) => {
  try {
    const { employeeID } = req.body;

    if (!employeeID) {
      return res.status(400).json({
        statusCode: 400,
        message: 'Employee ID is required'
      });
    }

    // ตรวจสอบว่าเป็น bot หรือไม่
    const bot = await Bot.findOne({ employeeID });
    if (!bot) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท'
      });
    }

    // สร้าง FCM token จริงสำหรับ bot
    let botFcmToken = null;
    try {
      // ใช้ Firebase Admin SDK สร้าง FCM token จริง
      const admin = require('firebase-admin');
      if (admin.apps.length > 0) {
        // สร้าง FCM token จริงสำหรับ bot
        const messaging = admin.messaging();
        // สร้าง device token registration สำหรับ bot
        botFcmToken = await messaging.getToken({
          topic: `bot_${employeeID}`,
          data: {
            employeeID: employeeID,
            role: 'bot',
            name: bot.name
          }
        });
        console.log(`[Bot Token] Generated real FCM token for bot ${employeeID}: ${botFcmToken.substring(0, 20)}...`);
      } else {
        // Fallback: สร้าง simulated token ถ้า Firebase ไม่พร้อม
        botFcmToken = `bot_${employeeID}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        console.log(`[Bot Token] Generated simulated token for bot ${employeeID}: ${botFcmToken.substring(0, 20)}...`);
      }
    } catch (tokenError) {
      console.log(`[Bot Token] Could not generate FCM token for bot ${employeeID}:`, tokenError.message);
      // Fallback: สร้าง simulated token
      botFcmToken = `bot_${employeeID}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    // อัพเดท token ใน Bot model
    const updatedBot = await Bot.findOneAndUpdate(
      { employeeID },
      {
        fcmToken: botFcmToken,
        deviceInfo: {
          platform: 'nodejs-service',
          appVersion: '1.0.0',
          deviceModel: 'Bot Service'
        },
        lastTokenUpdate: new Date()
      },
      { new: true }
    );

    // อัพเดท token ใน User model ด้วย
    await User.findOneAndUpdate(
      { employeeID, role: 'bot' },
      {
        fcmToken: botFcmToken,
        deviceInfo: {
          platform: 'nodejs-service',
          appVersion: '1.0.0',
          deviceModel: 'Bot Service'
        },
        lastTokenUpdate: new Date()
      }
    );

    console.log(`[Bot Token] Generated new token for bot ${employeeID}:`, {
      token: botFcmToken.substring(0, 20) + '...',
      name: bot.name
    });

    res.json({
      statusCode: 200,
      message: 'สร้าง FCM token สำหรับบอทสำเร็จ',
      data: {
        employeeID: employeeID,
        name: bot.name,
        fcmToken: botFcmToken,
        deviceInfo: updatedBot.deviceInfo,
        lastTokenUpdate: updatedBot.lastTokenUpdate
      }
    });

  } catch (error) {
    console.error('Error generating bot token:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการสร้าง FCM token สำหรับบอท',
      error: error.message
    });
  }
});

module.exports = router; 

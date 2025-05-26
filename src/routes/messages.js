const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const { getThaiTime, getThaiTimeISOString } = require('../utils/timeUtils');
const { findUserByEmployeeId } = require('../services/ldapServices');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Bot = require('../models/Bot');

// Configure multer for image upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const roomId = req.body.roomId;
    const uploadDir = path.join(__dirname, '../../uploads/rooms', roomId);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Check file extension
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    // Check both mimetype and extension
    if (!file.mimetype.startsWith('image/') || !allowedExtensions.includes(ext)) {
      console.log('File validation failed:', {
        filename: file.originalname,
        mimetype: file.mimetype,
        extension: ext
      });
      return cb(new Error('Only image files (jpg, jpeg, png, gif, webp) are allowed!'), false);
    }
    cb(null, true);
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Send message to room (text only)
router.post('/send', async (req, res) => {
  try {
    const { roomId, message, employeeId, isAdminNotification } = req.body;
    
    console.log('=== Send Message Debug Logs ===');
    console.log('Sender employeeId:', employeeId);
    console.log('Message content:', message);
    
    // Handle message array or single message
    let messageText;
    if (Array.isArray(message)) {
      // Filter out empty messages and join with newline
      messageText = message.filter(m => m && m.trim() !== '').join('\n');
    } else {
      messageText = message || '';
    }
    console.log('Processed message text:', messageText);

    // Check if sender is a bot
    const botUser = await User.findOne({ employeeID: employeeId, role: 'bot' });
    let sender;
    
    if (botUser) {
      // If sender is a bot, get bot details
      console.log('Sender is a bot, fetching bot details');
      const bot = await Bot.findOne({ employeeID: employeeId });
      if (!bot) {
        console.log('Bot not found for employeeId:', employeeId);
        return res.status(404).json({ 
          statusCode: 404,
          message: 'ไม่พบข้อมูลบอท' 
        });
      }
      sender = {
        employeeID: bot.employeeID,
        fullName: bot.name,
        department: 'bot notify',
        role: 'bot',
        imgUrl: 'http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/65166.jpg'
      };
      console.log('Found bot:', bot.name);
    } else {
      // If sender is a user, get user details from LDAP
      console.log('Sender is a user, fetching user details from LDAP');
      const userDetails = await findUserByEmployeeId(employeeId);
      if (!userDetails.success || !userDetails.user) {
        console.log('User not found for employeeId:', employeeId);
        return res.status(404).json({ 
          statusCode: 404,
          message: 'ไม่พบข้อมูลผู้ใช้ในระบบ' 
        });
      }
      sender = {
        employeeID: userDetails.user.employeeID,
        fullName: userDetails.user.fullName,
        department: userDetails.user.department,
        imgUrl: userDetails.user.imgUrl || null,
        role: 'user'
      };
      console.log('Found user:', userDetails.user.fullName);
    }

    const room = await Room.findById(roomId);
    if (!room) {
      console.log('Room not found:', roomId);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }
    console.log('Found room:', room.name);

    const messages = [];
    const roomIds = Array.isArray(roomId) ? roomId : [roomId];

    // Get io instance
    const io = req.app.get('io');
    if (!io) {
      console.error('Socket.IO instance not found');
      return res.status(500).json({ 
        statusCode: 500,
        message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ real-time' 
      });
    }

    for (const roomId of roomIds) {
      console.log(`\nProcessing room: ${roomId}`);
      // Create message record
      const messageObj = new Message({
        room: roomId,
        sender: employeeId,
        isRead: false,
        createdAt: getThaiTime(),
        isImage: false,
        imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
        isAdminNotification: isAdminNotification || false,
        ...(messageText ? { message: messageText } : {})
      });

      await messageObj.save();
      messages.push(messageObj);
      console.log('Message saved to database:', messageObj._id);

      // Update room's lastMessage and increment unreadCount for all members except sender
      await Room.findByIdAndUpdate(roomId, {
        $set: {
          lastMessage: {
            message: messageText,
            sender: employeeId,
            timestamp: messageObj.createdAt,
            isoString: getThaiTimeISOString(messageObj.createdAt),
            isImage: false,
            imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
            isAdminNotification: isAdminNotification || false
          }
        },
        $inc: {
          'unreadCounts.$[elem].count': 1
        }
      }, {
        arrayFilters: [{ 'elem.user': { $ne: employeeId } }]
      });
      console.log('Room updated with new lastMessage');

      // Emit message through Socket.IO with acknowledgment
      try {
        console.log(`Attempting to emit message to room ${roomId}`);
        console.log('Connected sockets in room:', io.sockets.adapter.rooms.get(roomId.toString()));
        
        io.to(roomId).emit('newMessage', {
          _id: messageObj._id,
          room: roomId,
          sender: sender,
          timestamp: messageObj.createdAt,
          isRead: false,
          isImage: false,
          imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
          isAdminNotification: isAdminNotification || false,
          ...(messageText ? { message: messageText } : {}),
          success: true
        }, (response) => {
          if (response && response.error) {
            console.error(`Error broadcasting message to room ${roomId}:`, response.error);
          } else {
            console.log(`Message broadcasted to room ${roomId} successfully`);
            console.log('Message details:', {
              roomId,
              messageId: messageObj._id,
              timestamp: messageObj.createdAt,
              sender: sender.fullName
            });
          }
        });
      } catch (error) {
        console.error(`Error emitting message to room ${roomId}:`, error);
      }
    }

    console.log('=== End Send Message Debug Logs ===\n');

    res.json({
      statusCode: 200,
      message: 'ส่งข้อความสำเร็จ',
      data: messages.map(message => ({
        _id: message._id,
        room: message.room,
        sender: sender,
        timestamp: message.createdAt,
        isRead: message.isRead,
        isImage: false,
        imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
        isAdminNotification: message.isAdminNotification,
        ...(message.message ? { message: message.message } : {})
      }))
    });

  } catch (error) {
    console.error('Error sending messages:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการส่งข้อความ',
      error: error.message 
    });
  }
});
 
// Send message from bot to all its rooms
router.post('/bot-send', async (req, res) => {
  try {
    const { employeeId, message } = req.body;
    let isAdminNotification = true

    // Get io instance first
    const io = req.app.get('io');
    if (!io) {
      console.error('Socket.IO instance not found');
      return res.status(500).json({ 
        statusCode: 500,
        message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ real-time' 
      });
    }

    console.log('=== Bot Send Debug Logs ===');
    console.log('Bot employeeId:', employeeId);
    console.log('Message content:', message);
    
    // Handle message array or single message
    let messageText;
    if (Array.isArray(message)) {
      // Filter out empty messages and join with newline
      messageText = message.filter(m => m && m.trim() !== '').join('\n');
    } else {
      messageText = message || '';
    }
    console.log('Processed message text:', messageText);

    // Find bot details
    const bot = await Bot.findOne({ employeeID: employeeId });
    if (!bot) {
      console.log('Bot not found for employeeId:', employeeId);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบข้อมูลบอท' 
      });
    }
    console.log('Found bot:', bot.name);

    // Find bot user
    const botUser = await User.findOne({ employeeID: employeeId, role: 'bot' });
    if (!botUser) {
      console.log('Bot user not found for employeeId:', employeeId);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบข้อมูลผู้ใช้ของบอท' 
      });
    }
    console.log('Found bot user:', botUser.employeeID);

    // Find all rooms where this bot is a member
    const rooms = await Room.find({
      'members.empId': employeeId
    });

    if (rooms.length === 0) {
      console.log('No rooms found for bot:', employeeId);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องที่บอทเป็นสมาชิก' 
      });
    }

    const messages = [];
    const roomIds = rooms.map(room => room._id);
    console.log('บอทกำลังส่งข้อความไปยังห้อง:', roomIds);
    console.log('ห้องที่ socket บอทอยู่:', io.sockets.adapter.rooms);

    for (const roomId of roomIds) {
      console.log(`\nProcessing room: ${roomId}`);
      // Create message record
      const messageObj = new Message({
        room: roomId,
        sender: employeeId,
        isRead: false,
        createdAt: getThaiTime(),
        isImage: false,
        imageUrl: "http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/65166.jpg",
        isAdminNotification: isAdminNotification || false,
        ...(messageText ? { message: messageText } : {})
      });

      await messageObj.save();
      messages.push(messageObj);
      console.log('Message saved to database:', messageObj._id);

      // Update room's lastMessage and increment unreadCount for all members except sender
      await Room.findByIdAndUpdate(roomId, {
        $set: {
          lastMessage: {
            message: messageText,
            sender: employeeId,
            timestamp: messageObj.createdAt,
            isoString: getThaiTimeISOString(messageObj.createdAt),
            isImage: false,
            imageUrl: null,
            isAdminNotification: isAdminNotification || false
          }
        },
        $inc: {
          'unreadCounts.$[elem].count': 1
        }
      }, {
        arrayFilters: [{ 'elem.user': { $ne: employeeId } }]
      });
      console.log('Room updated with new lastMessage');

      // Emit message through Socket.IO with acknowledgment
      const io = req.app.get('io');
      if (io) {
        try {
          console.log(`Attempting to emit message to room ${roomId}`);
          console.log('Connected sockets in room:', io.sockets.adapter.rooms.get(roomId.toString()));
          
          io.to(roomId).emit('newMessage', {
            _id: messageObj._id,
            room: roomId,
            sender: {
              employeeID: bot.employeeID,
              fullName: bot.name,
              department: 'bot notify',
              role: 'bot',
              imgUrl: 'http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/65166.jpg'
            },
            timestamp: messageObj.createdAt,
            isRead: false,
            isImage: false,
            imageUrl: null,
            isAdminNotification: isAdminNotification || false,
            ...(messageText ? { message: messageText } : {}),
            success: true
          }, (response) => {
            if (response && response.error) {
              console.error(`Error broadcasting message to room ${roomId}:`, response.error);
            } else {
              console.log(`Message broadcasted to room ${roomId} successfully`);
              console.log('Message details:', {
                roomId,
                messageId: messageObj._id,
                timestamp: messageObj.createdAt,
                sender: bot.name
              });
            }
          });
        } catch (error) {
          console.error(`Error emitting message to room ${roomId}:`, error);
        }
      } else {
        console.error('Socket.IO instance not found');
      }
    }

    // Update bot's requestCount
    await Bot.findOneAndUpdate(
      { employeeID: employeeId },
      { $inc: { requestCount: 1 } }
    );
    console.log('Bot requestCount updated');

    console.log('=== End Bot Send Debug Logs ===\n');

    res.json({
      statusCode: 200,
      message: 'ส่งข้อความสำเร็จ',
      data: messages.map(message => ({
        _id: message._id,
        room: message.room,
        sender: {
          employeeID: bot.employeeID,
          fullName: bot.name,
          department: 'bot notify',
          role: 'bot',
          imgUrl: 'http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/65166.jpg'
        },
        timestamp: message.createdAt,
        isRead: message.isRead,
        isImage: false,
        imageUrl: null,
        isAdminNotification: isAdminNotification || false,
        ...(message.message ? { message: message.message } : {})
      }))
    });

  } catch (error) {
    console.error('Error sending bot messages:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการส่งข้อความ',
      error: error.message 
    });
  }
});

// Upload image to room
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const { roomId, employeeId } = req.body;
    const imageFile = req.file;

    if (!imageFile) {
      return res.status(400).json({
        statusCode: 400,
        message: 'กรุณาเลือกรูปภาพ'
      });
    }

    // Get user details from LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      // Delete uploaded file if user not found
      fs.unlinkSync(imageFile.path);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบข้อมูลผู้ใช้ในระบบ' 
      });
    }

    const user = userDetails.user;

    // Check if room exists
    const room = await Room.findById(roomId);
    if (!room) {
      // Delete uploaded file if room not found
      fs.unlinkSync(imageFile.path);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }

    // Create message record for the image
    const messageObj = new Message({
      room: roomId,
      sender: employeeId,
      isRead: false,
      createdAt: getThaiTime(),
      isImage: true,
      imageUrl: `/uploads/rooms/${roomId}/${path.basename(imageFile.path)}`
    });

    await messageObj.save();

    // Update room's lastMessage
    await Room.findByIdAndUpdate(roomId, {
      $set: {
        lastMessage: {
          message: '',
          sender: employeeId,
          timestamp: messageObj.createdAt,
          isoString: getThaiTimeISOString(messageObj.createdAt),
          isImage: true,
          imageUrl: `/uploads/rooms/${roomId}/${path.basename(imageFile.path)}`
        }
      },
      $inc: {
        'unreadCounts.$[elem].count': 1
      }
    }, {
      arrayFilters: [{ 'elem.user': { $ne: employeeId } }]
    });

    // Emit message through Socket.IO
    const io = req.app.get('io');
    if (io) {
      try {
        io.to(roomId).emit('newMessage', {
          _id: messageObj._id,
          room: roomId,
          sender: {
            employeeID: user.employeeID,
            fullName: user.fullName,
            department: user.department,
            imgUrl: user.imgUrl || null
          },
          timestamp: messageObj.createdAt,
          isRead: false,
          isImage: true,
          imageUrl: `/uploads/rooms/${roomId}/${path.basename(imageFile.path)}`,
          success: true
        });
      } catch (error) {
        console.error(`Error emitting image message to room ${roomId}:`, error);
      }
    }

    res.json({
      statusCode: 200,
      message: 'อัพโหลดรูปภาพสำเร็จ',
      data: {
        _id: messageObj._id,
        room: roomId,
        sender: {
          employeeID: user.employeeID,
          fullName: user.fullName,
          department: user.department,
          imgUrl: user.imgUrl || null
        },
        timestamp: messageObj.createdAt,
        isRead: false,
        isImage: true,
        imageUrl: `/uploads/rooms/${roomId}/${path.basename(imageFile.path)}`
      }
    });

  } catch (error) {
    // Delete uploaded file if error occurs
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error uploading image:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพโหลดรูปภาพ',
      error: error.message 
    });
  }
});

// Get message history for a room
router.get('/room/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // Get messages with pagination
    const messages = await Message.find({ room: roomId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Message.countDocuments({ room: roomId });

    // Get unique sender IDs (excluding null)
    const senderIds = [...new Set(messages.map(m => m.sender).filter(id => id !== null))];
    
    // Separate bot and user IDs
    const botIds = [];
    const userIds = [];
    
    // Get user and bot details
    const userPromises = [];
    const botPromises = [];
    
    for (const id of senderIds) {
      // Check if sender is a bot
      const botUser = await User.findOne({ employeeID: id, role: 'bot' });
      if (botUser) {
        botIds.push(id);
        botPromises.push(Bot.findOne({ employeeID: id }));
      } else {
        userIds.push(id);
        userPromises.push(findUserByEmployeeId(id));
      }
    }
    
    // Get all user and bot details
    const [userResults, botResults] = await Promise.all([
      Promise.all(userPromises),
      Promise.all(botPromises)
    ]);
    
    // Create maps for both users and bots
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = {
          employeeID: bot.employeeID,
          fullName: bot.name,
          department: 'bot notify',
          role: 'bot',
          imgUrl: null
        };
      }
      return map;
    }, {});

    const formattedMessages = messages.map(message => {
      // Handle null sender
      if (message.sender === null) {
        return {
          _id: message._id,
          room: message.room,
          sender: null,
          timestamp: message.createdAt,
          isRead: message.isRead,
          isImage: message.isImage,
          imageUrl: message.imageUrl,
          isAdminNotification: message.isAdminNotification,
          ...(message.message ? { message: message.message } : {})
        };
      }

      // Check if sender is a bot
      const isBot = botIds.includes(message.sender);
      const sender = isBot ? botMap[message.sender] : userMap[message.sender];

      return {
        _id: message._id,
        room: message.room,
        sender: sender || null,
        timestamp: message.createdAt,
        isRead: message.isRead,
        isImage: message.isImage,
        imageUrl: message.imageUrl,
        isAdminNotification: message.isAdminNotification,
        ...(message.message ? { message: message.message } : {})
      };
    });

    res.json({
      statusCode: 200,
      messages: formattedMessages,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalMessages: total
      }
    });
  } catch (error) {
    console.error('Error getting room messages:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อความ',
      error: error.message 
    });
  }
});

// Mark messages as read
router.post('/mark-read', async (req, res) => {
  try {
    const { messageIds, employeeId } = req.body;

    // Get the room IDs from the messages
    const messages = await Message.find({ _id: { $in: messageIds } });
    const roomIds = [...new Set(messages.map(m => m.room))];

    // Update message read status
    await Message.updateMany(
      { _id: { $in: messageIds } },
      {
        $addToSet: {
          readBy: {
            user: employeeId,
            readAt: getThaiTime()
          }
        },
        $set: { isRead: true }
      }
    );

    // Update unreadCount in Room for each room
    for (const roomId of roomIds) {
      await Room.updateOne(
        { _id: roomId },
        { 
          $set: { 
            'unreadCounts.$[elem].count': 0 
          }
        },
        { 
          arrayFilters: [{ 'elem.user': employeeId }]
        }
      );

      // Notify others in room through socket
      const io = req.app.get('io');
      if (io) {
        io.to(roomId.toString()).emit('unreadCountUpdate', {
          roomId,
          userId: employeeId,
          count: 0,
          timestamp: new Date()
        });
      }
    }

    res.json({ 
      statusCode: 200,
      message: 'อัพเดทสถานะการอ่านข้อความเรียบร้อยแล้ว'
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดทสถานะการอ่านข้อความ',
      error: error.message 
    });
  }
});

// Get message history for a user
router.get('/user/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // Get user details from LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบข้อมูลผู้ใช้ในระบบ' 
      });
    }

    // Get user's rooms from Room model
    const rooms = await Room.find({ members: employeeId });
    const roomIds = rooms.map(room => room._id);

    // Get messages from user's rooms
    const messages = await Message.find({
      room: { $in: roomIds }
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Message.countDocuments({
      room: { $in: roomIds }
    });

    // Get unique sender IDs (excluding null)
    const senderIds = [...new Set(messages.map(m => m.sender).filter(id => id !== null))];
    
    // Separate bot and user IDs
    const botIds = [];
    const userIds = [];
    
    // Get user and bot details
    const userPromises = [];
    const botPromises = [];
    
    for (const id of senderIds) {
      // Check if sender is a bot
      const botUser = await User.findOne({ employeeID: id, role: 'bot' });
      if (botUser) {
        botIds.push(id);
        botPromises.push(Bot.findOne({ employeeID: id }));
      } else {
        userIds.push(id);
        userPromises.push(findUserByEmployeeId(id));
      }
    }
    
    // Get all user and bot details
    const [userResults, botResults] = await Promise.all([
      Promise.all(userPromises),
      Promise.all(botPromises)
    ]);
    
    // Create maps for both users and bots
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = {
          employeeID: bot.employeeID,
          fullName: bot.name,
          department: 'bot notify',
          role: 'bot',
          imgUrl: null
        };
      }
      return map;
    }, {});

    const formattedMessages = messages.map(message => {
      // Handle null sender
      if (message.sender === null) {
        return {
          _id: message._id,
          room: message.room,
          sender: null,
          timestamp: message.createdAt,
          isRead: message.isRead,
          isImage: message.isImage,
          imageUrl: message.imageUrl,
          isAdminNotification: message.isAdminNotification,
          ...(message.message ? { message: message.message } : {})
        };
      }

      // Check if sender is a bot
      const isBot = botIds.includes(message.sender);
      const sender = isBot ? botMap[message.sender] : userMap[message.sender];

      return {
        _id: message._id,
        room: message.room,
        sender: sender || null,
        timestamp: message.createdAt,
        isRead: message.isRead,
        isImage: message.isImage,
        imageUrl: message.imageUrl,
        isAdminNotification: message.isAdminNotification,
        ...(message.message ? { message: message.message } : {})
      };
    });

    res.json({
      statusCode: 200,
      messages: formattedMessages,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalMessages: total
      }
    });
  } catch (error) {
    console.error('Error getting user messages:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อความ',
      error: error.message 
    });
  }
});

module.exports = router; 
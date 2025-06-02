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


// ✅ Helper function to get sender details
async function getSenderDetails(employeeId) {
  // Check if sender is a bot
  const botUser = await User.findOne({ employeeID: employeeId, role: 'bot' });
  
  if (botUser) {
    const bot = await Bot.findOne({ employeeID: employeeId });
    if (!bot) {
      throw new Error('ไม่พบข้อมูลบอท');
    }
    return {
      employeeID: bot.employeeID,
      fullName: bot.name,
      department: 'bot notify',
      role: 'bot',
      imgUrl: 'http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/65166.jpg'
    };
  } else {
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      throw new Error('ไม่พบข้อมูลผู้ใช้ในระบบ');
    }
    return {
      employeeID: userDetails.user.employeeID,
      fullName: userDetails.user.fullName,
      department: userDetails.user.department,
      imgUrl: userDetails.user.imgUrl || null,
      role: 'user'
    };
  }
}


// ✅ Send message to room (text only) - อัพเดทให้รองรับ reply
router.post('/send', async (req, res) => {
  try {
    const { roomId, message, employeeId, isAdminNotification, replyToId } = req.body;
    
    console.log('=== Send Message Debug Logs ===');
    console.log('Sender employeeId:', employeeId);
    console.log('Message content:', message);
    console.log('Reply to ID:', replyToId || 'Not a reply');
    
    // Handle message array or single message
    let messageText;
    if (Array.isArray(message)) {
      messageText = message.filter(m => m && m.trim() !== '').join('\n');
    } else {
      messageText = message || '';
    }

    // Get sender details
    const sender = await getSenderDetails(employeeId);

    // Check room exists
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }

    // Get io instance
    const io = req.app.get('io');
    const chatIo = io.of('/chat');  // Add chat namespace

    if (!io) {
      return res.status(500).json({ 
        statusCode: 500,
        message: 'เกิดข้อผิดพลาดในการเชื่อมต่อ real-time' 
      });
    }

    let messageObj;
    let replyToSenderDetails = null;

    // ✅ Check if this is a reply message
    if (replyToId) {
      console.log('Creating reply message');
      // Get the original message to reply to
      const originalMessage = await Message.findById(replyToId);
      if (originalMessage) {
        // Get sender details for the original message using getSenderDetails
        try {
          replyToSenderDetails = await getSenderDetails(originalMessage.sender);
          // Add profileImage URL for users
          if (replyToSenderDetails.role !== 'bot') {
            replyToSenderDetails.profileImage = `http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/${replyToSenderDetails.employeeID}.jpg`;
          }
        } catch (error) {
          console.warn('Failed to get reply sender details:', error.message);
          replyToSenderDetails = null;
        }
      }

      messageObj = await Message.createReply({
        roomId,
        sender: employeeId,
        message: messageText,
        replyToId,
        isImage: false
      });

      // Add sender details to the reply message
      if (messageObj.replyToMessage) {
        messageObj.replyToMessage = {
          ...messageObj.replyToMessage,
          sender: replyToSenderDetails ? {
            employeeID: replyToSenderDetails.employeeID,
            fullName: replyToSenderDetails.fullName,
            department: replyToSenderDetails.department,
            profileImage: replyToSenderDetails.role === 'bot' ? replyToSenderDetails.imgUrl : replyToSenderDetails.profileImage,
            role: replyToSenderDetails.role
          } : null
        };
      }
    } else {
      console.log('Creating regular message');
      // Create regular message
      messageObj = new Message({
        room: roomId,
        sender: employeeId,
        message: messageText,
        isRead: false,
        createdAt: getThaiTime(),
        isImage: false,
        imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
        isAdminNotification: isAdminNotification || false
      });
      await messageObj.save();
    }

    console.log('Message saved to database:', messageObj._id);

    // Update room's lastMessage
    const lastMessageData = {
      message: messageText,
      sender: employeeId,
      timestamp: messageObj.createdAt,
      isoString: getThaiTimeISOString(messageObj.createdAt),
      isImage: false,
      imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
      isAdminNotification: isAdminNotification || false
    };

    // ✅ Add reply information to lastMessage if it's a reply
    if (replyToId) {
      lastMessageData.isReply = true;
      lastMessageData.replyToId = replyToId;
    }

    await Room.findByIdAndUpdate(roomId, {
      $set: { lastMessage: lastMessageData },
      $inc: { 'unreadCounts.$[elem].count': 1 }
    }, {
      arrayFilters: [{ 'elem.user': { $ne: employeeId } }]
    });

    // ✅ Emit message through Socket.IO with reply data
    const socketData = {
      _id: messageObj._id,
      room: roomId,
      sender: sender,
      message: messageText,
      timestamp: messageObj.createdAt,
      isRead: false,
      isImage: false,
      imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
      isAdminNotification: isAdminNotification || false,
      success: true
    };

    // Add reply data if it's a reply
    if (replyToId && messageObj.replyToMessage) {
      socketData.isReply = true;
      socketData.replyTo = messageObj.replyTo;
      socketData.replyToMessage = {
        ...messageObj.replyToMessage,
        sender: replyToSenderDetails ? {
          employeeID: replyToSenderDetails.employeeID,
          fullName: replyToSenderDetails.fullName,
          department: replyToSenderDetails.department,
          profileImage: replyToSenderDetails.role === 'bot' ? replyToSenderDetails.imgUrl : replyToSenderDetails.profileImage,
          role: replyToSenderDetails.role
        } : null
      };
    }

    // Emit to both namespaces
    io.to(roomId).emit('newMessage', socketData);
    chatIo.to(roomId).emit('newMessage', socketData);
    console.log(`Message broadcasted to room ${roomId} successfully (both namespaces)`);

    // Response data
    const responseData = {
      _id: messageObj._id,
      room: messageObj.room,
      sender: sender,
      message: messageText,
      timestamp: messageObj.createdAt,
      isRead: messageObj.isRead,
      isImage: false,
      imageUrl: sender.role === 'bot' ? sender.imgUrl : null,
      isAdminNotification: messageObj.isAdminNotification
    };

    // Add reply data to response if it's a reply
    if (replyToId && messageObj.replyToMessage) {
      responseData.isReply = true;
      responseData.replyTo = messageObj.replyTo;
      responseData.replyToMessage = {
        ...messageObj.replyToMessage,
        sender: replyToSenderDetails ? {
          employeeID: replyToSenderDetails.employeeID,
          fullName: replyToSenderDetails.fullName,
          department: replyToSenderDetails.department,
          profileImage: replyToSenderDetails.role === 'bot' ? replyToSenderDetails.imgUrl : replyToSenderDetails.profileImage,
          role: replyToSenderDetails.role
        } : null
      };
    }

    res.json({
      statusCode: 200,
      message: replyToId ? 'ส่งข้อความตอบกลับสำเร็จ' : 'ส่งข้อความสำเร็จ',
      data: responseData
    });

  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการส่งข้อความ',
      error: error.message 
    });
  }
});


// ✅ Upload image to room - อัพเดทให้รองรับ reply
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const { roomId, employeeId, message, replyToId } = req.body;
    const imageFile = req.file;

    console.log('=== Upload Image Debug ===');
    console.log('Room ID:', roomId);
    console.log('Employee ID:', employeeId);
    console.log('Reply to ID:', replyToId || 'Not a reply');
    console.log('Optional message:', message);

    if (!imageFile) {
      return res.status(400).json({
        statusCode: 400,
        message: 'กรุณาเลือกรูปภาพ'
      });
    }

    // Get sender details
    const sender = await getSenderDetails(employeeId);

    // Check if room exists
    const room = await Room.findById(roomId);
    if (!room) {
      fs.unlinkSync(imageFile.path);
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }

    const imageUrl = `/uploads/rooms/${roomId}/${path.basename(imageFile.path)}`;
    let messageObj;

    // ✅ Check if this is a reply message
    if (replyToId) {
      console.log('Creating reply image message');
      messageObj = await Message.createReply({
        roomId,
        sender: employeeId,
        message: message || '',
        replyToId,
        isImage: true,
        imageUrl
      });
    } else {
      console.log('Creating regular image message');
      // Create regular image message
      messageObj = new Message({
        room: roomId,
        sender: employeeId,
        message: message || '',
        isRead: false,
        createdAt: getThaiTime(),
        isImage: true,
        imageUrl
      });
      await messageObj.save();
    }

    console.log('Image message saved:', messageObj._id);

    // Update room's lastMessage
    const lastMessageData = {
      message: message || '',
      sender: employeeId,
      timestamp: messageObj.createdAt,
      isoString: getThaiTimeISOString(messageObj.createdAt),
      isImage: true,
      imageUrl
    };

    // Add reply information if it's a reply
    if (replyToId) {
      lastMessageData.isReply = true;
      lastMessageData.replyToId = replyToId;
    }

    await Room.findByIdAndUpdate(roomId, {
      $set: { lastMessage: lastMessageData },
      $inc: { 'unreadCounts.$[elem].count': 1 }
    }, {
      arrayFilters: [{ 'elem.user': { $ne: employeeId } }]
    });

    // Emit through Socket.IO
    const io = req.app.get('io');
    if (io) {
      const socketData = {
        _id: messageObj._id,
        room: roomId,
        sender: sender,
        message: message || '',
        timestamp: messageObj.createdAt,
        isRead: false,
        isImage: true,
        imageUrl,
        success: true
      };

      // Add reply data if it's a reply
      if (replyToId && messageObj.replyToMessage) {
        socketData.isReply = true;
        socketData.replyTo = messageObj.replyTo;
        socketData.replyToMessage = messageObj.replyToMessage;
      }

      // Emit to both namespaces
      io.to(roomId).emit('newMessage', socketData);
      chatIo.to(roomId).emit('newMessage', socketData);
      console.log('Image message broadcasted successfully (both namespaces)');
    }

    // Response data
    const responseData = {
      _id: messageObj._id,
      room: roomId,
      sender: sender,
      message: message || '',
      timestamp: messageObj.createdAt,
      isRead: false,
      isImage: true,
      imageUrl
    };

    // Add reply data to response
    if (replyToId && messageObj.replyToMessage) {
      responseData.isReply = true;
      responseData.replyTo = messageObj.replyTo;
      responseData.replyToMessage = messageObj.replyToMessage;
    }

    res.json({
      statusCode: 200,
      message: replyToId ? 'ส่งรูปภาพตอบกลับสำเร็จ' : 'อัพโหลดรูปภาพสำเร็จ',
      data: responseData
    });

  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Error uploading image:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพโหลดรูปภาพ',
      error: error.message 
    });
  }
});


// ✅ Get message history for a room - อัพเดทให้รวม reply data
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
    
    // Get user and bot details
    const senderMap = {};
    for (const senderId of senderIds) {
      try {
        const senderDetails = await getSenderDetails(senderId);
        senderMap[senderId] = senderDetails;
      } catch (error) {
        console.warn(`Failed to get sender details for ${senderId}:`, error.message);
        senderMap[senderId] = null;
      }
    }

    // ✅ Format messages with reply data
    const formattedMessages = messages.map(message => {
      const baseMessage = {
        _id: message._id,
        room: message.room,
        sender: message.sender ? senderMap[message.sender] : null,
        timestamp: message.createdAt,
        isRead: message.isRead,
        isImage: message.isImage,
        imageUrl: message.imageUrl,
        isAdminNotification: message.isAdminNotification,
        ...(message.message ? { message: message.message } : {})
      };

      // ✅ Add reply data if message is a reply
      if (message.replyTo && message.replyToMessage) {
        baseMessage.isReply = true;
        baseMessage.replyTo = message.replyTo;
        baseMessage.replyToMessage = message.replyToMessage;
      }

      return baseMessage;
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

// ✅ NEW: Get message with its replies
router.get('/message/:messageId/replies', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    // Check if original message exists
    const originalMessage = await Message.findById(messageId);
    if (!originalMessage) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อความที่ระบุ'
      });
    }

    // Get replies
    const replies = await Message.find({ replyTo: messageId })
      .sort({ createdAt: 1 }) // Sort oldest first for thread view
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const totalReplies = await Message.countDocuments({ replyTo: messageId });

    // Get sender details for original message and replies
    const allMessages = [originalMessage, ...replies];
    const senderIds = [...new Set(allMessages.map(m => m.sender).filter(id => id))];
    
    const senderMap = {};
    for (const senderId of senderIds) {
      try {
        const senderDetails = await getSenderDetails(senderId);
        senderMap[senderId] = senderDetails;
      } catch (error) {
        console.warn(`Failed to get sender details for ${senderId}:`, error.message);
        senderMap[senderId] = null;
      }
    }

    // Format original message
    const formattedOriginalMessage = {
      _id: originalMessage._id,
      message: originalMessage.message || '',
      sender: senderMap[originalMessage.sender] || null,
      timestamp: originalMessage.createdAt,
      isImage: originalMessage.isImage,
      imageUrl: originalMessage.imageUrl,
      isRead: originalMessage.isRead,
      replyCount: totalReplies
    };

    // Format replies
    const formattedReplies = replies.map(reply => ({
      _id: reply._id,
      message: reply.message || '',
      sender: senderMap[reply.sender] || null,
      timestamp: reply.createdAt,
      isImage: reply.isImage,
      imageUrl: reply.imageUrl,
      isRead: reply.isRead,
      isReply: true,
      replyTo: reply.replyTo,
      replyToMessage: reply.replyToMessage
    }));

    res.json({
      statusCode: 200,
      data: {
        originalMessage: formattedOriginalMessage,
        replies: formattedReplies,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalReplies / limit),
          totalReplies,
          hasMore: page * limit < totalReplies
        }
      }
    });

  } catch (error) {
    console.error('Error getting message replies:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลการตอบกลับ',
      error: error.message
    });
  }
});

// ✅ NEW: Get reply count for a message
router.get('/message/:messageId/reply-count', async (req, res) => {
  try {
    const { messageId } = req.params;

    const replyCount = await Message.countDocuments({ replyTo: messageId });

    res.json({
      statusCode: 200,
      data: {
        messageId,
        replyCount
      }
    });

  } catch (error) {
    console.error('Error getting reply count:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการนับจำนวนการตอบกลับ',
      error: error.message
    });
  }
});

// Mark messages as read (existing endpoint - no changes needed)
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

// ✅ Get message history for a user - อัพเดทให้รวม reply data
router.get('/user/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    // Get user details
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบข้อมูลผู้ใช้ในระบบ' 
      });
    }

    // Get user's rooms
    const rooms = await Room.find({
      $or: [
        { 'members.empId': employeeId },
        { 'admin.empId': employeeId }
      ]
    });
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

    // Get sender details
    const senderIds = [...new Set(messages.map(m => m.sender).filter(id => id !== null))];
    const senderMap = {};
    
    for (const senderId of senderIds) {
      try {
        const senderDetails = await getSenderDetails(senderId);
        senderMap[senderId] = senderDetails;
      } catch (error) {
        console.warn(`Failed to get sender details for ${senderId}:`, error.message);
        senderMap[senderId] = null;
      }
    }

    // ✅ Format messages with reply data
    const formattedMessages = messages.map(message => {
      const baseMessage = {
        _id: message._id,
        room: message.room,
        sender: message.sender ? senderMap[message.sender] : null,
        timestamp: message.createdAt,
        isRead: message.isRead,
        isImage: message.isImage,
        imageUrl: message.imageUrl,
        isAdminNotification: message.isAdminNotification,
        ...(message.message ? { message: message.message } : {})
      };

      // Add reply data if message is a reply
      if (message.replyTo && message.replyToMessage) {
        baseMessage.isReply = true;
        baseMessage.replyTo = message.replyTo;
        baseMessage.replyToMessage = message.replyToMessage;
      }

      return baseMessage;
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

// Delete message
router.delete('/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { employeeId } = req.body; // ID ของผู้ใช้ที่ต้องการลบข้อความ

    console.log('=== Delete Message Debug ===');
    console.log('Message ID:', messageId);
    console.log('Employee ID:', employeeId);

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบข้อความที่ต้องการลบ'
      });
    }

    // Get room details
    const room = await Room.findById(message.room);
    if (!room) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบห้องแชท'
      });
    }

    // Check permissions
    const isMessageSender = message.sender === employeeId;
    const isRoomAdmin = room.admin.empId === employeeId;
    const isHrOrAdmin = await User.findOne({ 
      employeeID: employeeId, 
      role: { $in: ['admin', 'Hr'] } 
    });

    if (!isMessageSender && !isRoomAdmin && !isHrOrAdmin) {
      return res.status(403).json({
        statusCode: 403,
        message: 'คุณไม่มีสิทธิ์ลบข้อความนี้'
      });
    }

    // If message has an image, delete the image file
    if (message.isImage && message.imageUrl) {
      const imagePath = path.join(__dirname, '..', '..', message.imageUrl);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    // Delete the message
    await message.deleteOne();

    // Update room's lastMessage if the deleted message was the last message
    const lastMessage = await Message.findOne({ room: message.room })
      .sort({ createdAt: -1 })
      .limit(1);

    if (lastMessage) {
      // Get sender details for the new last message
      const senderDetails = await getSenderDetails(lastMessage.sender);
      const lastMessageData = {
        message: lastMessage.message,
        sender: lastMessage.sender, // ใช้แค่ employeeID
        timestamp: lastMessage.createdAt,
        isoString: getThaiTimeISOString(lastMessage.createdAt),
        isImage: lastMessage.isImage,
        imageUrl: lastMessage.imageUrl,
        isAdminNotification: lastMessage.isAdminNotification
      };

      // Add reply information if it's a reply
      if (lastMessage.replyTo && lastMessage.replyToMessage) {
        lastMessageData.isReply = true;
        lastMessageData.replyToId = lastMessage.replyTo;
      }

      await Room.findByIdAndUpdate(message.room, {
        $set: { lastMessage: lastMessageData }
      });
    } else {
      // If no messages left, clear lastMessage
      await Room.findByIdAndUpdate(message.room, {
        $set: { lastMessage: null }
      });
    }

    // Notify room members through socket
    const io = req.app.get('io');
    if (io) {
      // ส่ง event messageDeleted พร้อมข้อมูลที่จำเป็น
      const socketData = {
        messageId,
        roomId: message.room,
        deletedBy: {
          employeeID: employeeId,
          // เพิ่มข้อมูลผู้ลบเพื่อแสดงในแชท
          ...(await getSenderDetails(employeeId))
        },
        timestamp: new Date(),
        lastMessage: null // เตรียมข้อมูล lastMessage ใหม่
      };

      // ถ้ามีข้อความล่าสุด ให้เพิ่มข้อมูล lastMessage
      if (lastMessage) {
        const senderDetails = await getSenderDetails(lastMessage.sender);
        socketData.lastMessage = {
          message: lastMessage.message,
          sender: {
            employeeID: senderDetails.employeeID,
            fullName: senderDetails.fullName,
            department: senderDetails.department,
            profileImage: senderDetails.role === 'bot' ? senderDetails.imgUrl : 
              `http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/${senderDetails.employeeID}.jpg`,
            role: senderDetails.role
          },
          timestamp: lastMessage.createdAt,
          isoString: getThaiTimeISOString(lastMessage.createdAt),
          isImage: lastMessage.isImage,
          imageUrl: lastMessage.imageUrl,
          isAdminNotification: lastMessage.isAdminNotification
        };

        // เพิ่มข้อมูล reply ถ้ามี
        if (lastMessage.replyTo && lastMessage.replyToMessage) {
          socketData.lastMessage.isReply = true;
          socketData.lastMessage.replyToId = lastMessage.replyTo;
        }
      }

      // ส่ง event ไปยังทุกคนในห้อง
      io.to(message.room.toString()).emit('messageDeleted', socketData);

      // อัพเดท chat list สำหรับทุกคน
      const updateChatList = req.app.get('updateChatList');
      if (updateChatList) {
        await updateChatList(message.room);
      }

      console.log('Message deletion broadcasted to room:', message.room);
    }

    res.json({
      statusCode: 200,
      message: 'ลบข้อความสำเร็จ',
      data: {
        messageId,
        roomId: message.room,
        deletedAt: new Date()
      }
    });

  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการลบข้อความ',
      error: error.message
    });
  }
});

module.exports = router;  
const express = require('express');
const router = express.Router();
const DirectMessage = require('../models/DirectMessage');
const { findUserByEmployeeId } = require('../services/ldapServices');
const { getThaiTime, getThaiTimeISOString, formatThaiDateTime, formatThaiDateTimeDirectMessage } = require('../utils/timeUtils');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// สร้าง folder ถ้ายังไม่มี
const uploadDir = path.join(__dirname, '../../uploads/directMessage');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// กำหนด storage สำหรับ multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // สร้างชื่อ folder จาก employee ID ของคู่สนทนา
    const { employeeId, recipientId } = req.body;
    if (!employeeId || !recipientId) {
      return cb(new Error('Missing employeeId or recipientId'));
    }

    // เรียง employee ID จากน้อยไปมากเพื่อให้ชื่อ folder เหมือนกันไม่ว่าจะใครส่งก่อน
    const [id1, id2] = [employeeId, recipientId].sort();
    const conversationFolder = path.join(uploadDir, `${id1}-${id2}`);

    // สร้าง folder ถ้ายังไม่มี
    if (!fs.existsSync(conversationFolder)) {
      fs.mkdirSync(conversationFolder, { recursive: true });
    }

    cb(null, conversationFolder);
  },
  filename: function (req, file, cb) {
    // สร้างชื่อไฟล์แบบ unique โดยใช้ timestamp และ employeeId
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    // เพิ่ม employeeId เข้าไปในชื่อไฟล์เพื่อระบุผู้ส่ง
    const employeeId = req.body.employeeId;
    cb(null, `${employeeId}-${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

// กำหนด file filter
const fileFilter = (req, file, cb) => {
  // ตรวจสอบประเภทไฟล์
  if (file.fieldname === 'image') {
    // สำหรับรูปภาพ
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('กรุณาอัพโหลดไฟล์รูปภาพเท่านั้น'), false);
    }
  } else if (file.fieldname === 'file') {
    // สำหรับไฟล์ทั่วไป
    cb(null, true);
  } else {
    cb(new Error('ไม่รองรับประเภทไฟล์นี้'), false);
  }
};

// สร้าง multer upload instance
const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // จำกัดขนาดไฟล์ 10MB
  }
});

// ส่งข้อความปกติ
router.post('/send', async (req, res) => {
  try {
    const { recipientId, message, employeeId, replyToId } = req.body;

    if (!recipientId || !employeeId) {
      return res.status(400).json({ error: 'กรุณาระบุผู้รับและผู้ส่งข้อความ' });
    }

    if (!message) {
      return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    }

    // ตรวจสอบผู้ใช้จาก LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้งานในระบบ LDAP' });
    }

    let newMessage;
    if (replyToId) {
      // สร้างข้อความตอบกลับ
      newMessage = await DirectMessage.createReply({
        participants: [employeeId, recipientId],
        sender: employeeId,
        message,
        replyToId
      });
    } else {
      // สร้างข้อความใหม่
      newMessage = new DirectMessage({
        participants: [employeeId, recipientId],
        sender: employeeId,
        message
      });
      await newMessage.save();
    }

    // ส่ง WebSocket notification
    const io = req.app.get('io');
    if (io) {
      console.log('Socket.IO instance found, preparing to emit...');
      
      // ถ้ามี replyToId ให้ดึงข้อมูลผู้ส่งของข้อความที่ตอบกลับ
      let replyToSender = null;
      if (replyToId) {
        const replyMessage = await DirectMessage.findById(replyToId);
        if (replyMessage) {
          const replySenderDetails = await findUserByEmployeeId(replyMessage.sender);
          if (replySenderDetails.success && replySenderDetails.user) {
            replyToSender = {
              employeeID: replySenderDetails.user.employeeID,
              fullName: replySenderDetails.user.fullNameThai,
              department: replySenderDetails.user.department,
              imgUrl: replySenderDetails.user.imgUrl || null
            };
          }
        }
      }

      const socketData = {
        _id: newMessage._id,
        participants: newMessage.participants,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullNameThai,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        isRead: false,
        isImage: newMessage.isImage || false,
        imageUrl: newMessage.imageUrl || null,
        isFile: newMessage.isFile || false,
        fileUrl: newMessage.fileUrl || null,
        fileName: newMessage.fileName || null,
        fileType: newMessage.fileType || null,
        replyTo: newMessage.replyTo || null,
        replyToMessage: newMessage.replyToMessage ? {
          messageId: newMessage.replyToMessage._id,
          sender: replyToSender,
          message: newMessage.replyToMessage.message,
          isImage: newMessage.replyToMessage.isImage || false,
          imageUrl: newMessage.replyToMessage.imageUrl || null,
          isFile: newMessage.replyToMessage.isFile || false,
          fileUrl: newMessage.replyToMessage.fileUrl || null,
          fileName: newMessage.replyToMessage.fileName || null,
          fileType: newMessage.replyToMessage.fileType || null,
          createdAt: newMessage.replyToMessage.createdAt
        } : false,
        readBy: newMessage.readBy.map(read => ({
          user: read.user,
          readAt: getThaiTimeISOString(read.readAt),
          _id: read._id
        })),
        createdAt: getThaiTime(newMessage.createdAt),
        isoString: getThaiTimeISOString(newMessage.createdAt),
        success: true
      };

      console.log('Emitting newDirectMessage to recipient:', recipientId);
      console.log('Socket data:', JSON.stringify(socketData, null, 2));
      
      // ส่งข้อความไปยังผู้รับ
      io.to(recipientId).emit('newDirectMessage', socketData);

      // ส่ง notification
      const notificationData = {
        _id: newMessage._id,
        participants: newMessage.participants,
        recipientId,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullNameThai,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        isRead: false,
        isImage: newMessage.isImage || false,
        imageUrl: newMessage.imageUrl || null,
        isFile: newMessage.isFile || false,
        fileUrl: newMessage.fileUrl || null,
        fileName: newMessage.fileName || null,
        fileType: newMessage.fileType || null,
        replyTo: newMessage.replyTo || null,
        replyToMessage: newMessage.replyToMessage ? {
          messageId: newMessage.replyToMessage._id,
          sender: replyToSender,
          message: newMessage.replyToMessage.message,
          isImage: newMessage.replyToMessage.isImage || false,
          imageUrl: newMessage.replyToMessage.imageUrl || null,
          isFile: newMessage.replyToMessage.isFile || false,
          fileUrl: newMessage.replyToMessage.fileUrl || null,
          fileName: newMessage.replyToMessage.fileName || null,
          fileType: newMessage.replyToMessage.fileType || null,
          createdAt: newMessage.replyToMessage.createdAt
        } : false,
        readBy: newMessage.readBy.map(read => ({
          user: read.user,
          readAt: getThaiTimeISOString(read.readAt),
          _id: read._id
        })),
        createdAt: getThaiTime(newMessage.createdAt),
        isoString: getThaiTimeISOString(newMessage.createdAt),
        success: true
      };

      console.log('Emitting newDirectMessageNotification to all clients');
      console.log('Notification data:', JSON.stringify(notificationData, null, 2));
      
      io.emit('newDirectMessageNotification', notificationData);
    } else {
      console.error('Socket.IO instance not found!');
    }

    // ถ้ามี replyToId ให้ดึงข้อมูลผู้ส่งของข้อความที่ตอบกลับสำหรับ response
    let replyToSender = null;
    if (replyToId) {
      const replyMessage = await DirectMessage.findById(replyToId);
      if (replyMessage) {
        const replySenderDetails = await findUserByEmployeeId(replyMessage.sender);
        if (replySenderDetails.success && replySenderDetails.user) {
          replyToSender = {
            employeeID: replySenderDetails.user.employeeID,
            fullName: replySenderDetails.user.fullNameThai,
            department: replySenderDetails.user.department,
            imgUrl: replySenderDetails.user.imgUrl || null
          };
        }
      }
    }

    // Format response with Thai time
    const messageObj = newMessage.toObject();
    const formattedMessage = {
      replyToMessage: messageObj.replyToMessage ? {
        messageId: messageObj.replyToMessage._id,
        sender: replyToSender,
        message: messageObj.replyToMessage.message,
        isImage: messageObj.replyToMessage.isImage || false,
        imageUrl: messageObj.replyToMessage.imageUrl || null,
        isFile: messageObj.replyToMessage.isFile || false,
        fileUrl: messageObj.replyToMessage.fileUrl || null,
        fileName: messageObj.replyToMessage.fileName || null,
        fileType: messageObj.replyToMessage.fileType || null,
        createdAt: messageObj.replyToMessage.createdAt
      } : false,
      _id: messageObj._id,
      participants: messageObj.participants,
      sender: {
        employeeID: userDetails.user.employeeID,
        fullName: userDetails.user.fullNameThai,
        department: userDetails.user.department,
        imgUrl: userDetails.user.imgUrl || null
      },
      message: messageObj.message,
      isRead: messageObj.isRead,
      isImage: messageObj.isImage || false,
      imageUrl: messageObj.imageUrl || null,
      isFile: messageObj.isFile || false,
      fileUrl: messageObj.fileUrl || null,
      fileName: messageObj.fileName || null,
      fileType: messageObj.fileType || null,
      replyTo: messageObj.replyTo || null,
      readBy: messageObj.readBy.map(read => ({
        user: read.user,
        readAt: getThaiTimeISOString(read.readAt),
        _id: read._id
      })),
      createdAt: getThaiTime(messageObj.createdAt),
      __v: messageObj.__v,
      isoString: getThaiTimeISOString(messageObj.createdAt)
    };

    res.status(201).json({
      success: true,
      message: 'ส่งข้อความสำเร็จ',
      data: formattedMessage
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถส่งข้อความได้' });
  }
});

// ส่งรูปภาพ
router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    const { recipientId, message, employeeId, replyToId } = req.body;
    const image = req.file;


    if (!recipientId || !employeeId) {
      return res.status(400).json({ 
        error: 'กรุณาระบุผู้รับและผู้ส่งข้อความ',
        details: { recipientId, employeeId }
      });
    }

    if (!image) {
      return res.status(400).json({ 
        error: 'กรุณาอัพโหลดรูปภาพ',
        details: { receivedFile: req.file ? req.file.originalname : null }
      });
    }

    // ตรวจสอบว่า recipientId เป็น employee ID ไม่ใช่ Room ID
    if (recipientId.length !== 5) {
      return res.status(400).json({ 
        error: 'Invalid recipient ID format. Please provide a valid employee ID.',
        details: { recipientId }
      });
    }

    // ตรวจสอบผู้ใช้จาก LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ 
        error: 'ไม่พบผู้ใช้งานในระบบ LDAP',
        details: { employeeId }
      });
    }

    // ตรวจสอบผู้รับจาก LDAP
    const recipientDetails = await findUserByEmployeeId(recipientId);
    if (!recipientDetails.success || !recipientDetails.user) {
      return res.status(404).json({ 
        error: 'ไม่พบผู้รับในระบบ LDAP',
        details: { recipientId }
      });
    }

    // สร้าง URL สำหรับรูปภาพ (ปรับ path ให้สอดคล้องกับ folder structure ใหม่)
    const [id1, id2] = [employeeId, recipientId].sort();
    const imageUrl = `/uploads/directMessage/${id1}-${id2}/${image.filename}`;

    let newMessage;
    if (replyToId) {
      // สร้างข้อความตอบกลับพร้อมรูปภาพ
      newMessage = await DirectMessage.createReply({
        participants: [employeeId, recipientId],
        sender: employeeId,
        message: message || '',
        replyToId,
        isImage: true,
        imageUrl
      });
    } else {
      // สร้างข้อความใหม่พร้อมรูปภาพ
      newMessage = new DirectMessage({
        participants: [employeeId, recipientId],
        sender: employeeId,
        message: message || '',
        isImage: true,
        imageUrl
      });
      await newMessage.save();
    }

    // ส่ง WebSocket notification
    const io = req.app.get('io');
    if (io) {
      // ถ้ามี replyToId ให้ดึงข้อมูลผู้ส่งของข้อความที่ตอบกลับ
      let replyToSender = null;
      if (replyToId) {
        const replyMessage = await DirectMessage.findById(replyToId);
        if (replyMessage) {
          const replySenderDetails = await findUserByEmployeeId(replyMessage.sender);
          if (replySenderDetails.success && replySenderDetails.user) {
            replyToSender = {
              employeeID: replySenderDetails.user.employeeID,
              fullName: replySenderDetails.user.fullNameThai,
              department: replySenderDetails.user.department,
              imgUrl: replySenderDetails.user.imgUrl || null
            };
          }
        }
      }

      const socketData = {
        _id: newMessage._id,
        participants: newMessage.participants,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullNameThai,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        isRead: false,
        isImage: true,
        imageUrl: newMessage.imageUrl,
        replyTo: newMessage.replyTo || null,
        replyToMessage: newMessage.replyToMessage ? {
          messageId: newMessage.replyToMessage._id,
          sender: replyToSender,
          message: newMessage.replyToMessage.message,
          isImage: newMessage.replyToMessage.isImage || false,
          imageUrl: newMessage.replyToMessage.imageUrl || null,
          isFile: newMessage.replyToMessage.isFile || false,
          fileUrl: newMessage.replyToMessage.fileUrl || null,
          fileName: newMessage.replyToMessage.fileName || null,
          fileType: newMessage.replyToMessage.fileType || null,
          createdAt: newMessage.replyToMessage.createdAt
        } : null,
        readBy: newMessage.readBy.map(read => ({
          user: read.user,
          readAt: getThaiTimeISOString(read.readAt),
          _id: read._id
        })),
        createdAt: getThaiTime(newMessage.createdAt),
        isoString: getThaiTimeISOString(newMessage.createdAt),
        success: true
      };

      // ส่งข้อความไปยังผู้รับ
      io.to(recipientId).emit('newDirectMessage', socketData);

      // ส่ง notification
      const notificationData = {
        _id: newMessage._id,
        participants: newMessage.participants,
        recipientId,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullNameThai,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        isRead: false,
        isImage: true,
        imageUrl: newMessage.imageUrl,
        replyTo: newMessage.replyTo || null,
        replyToMessage: newMessage.replyToMessage ? {
          messageId: newMessage.replyToMessage._id,
          sender: replyToSender,
          message: newMessage.replyToMessage.message,
          isImage: newMessage.replyToMessage.isImage || false,
          imageUrl: newMessage.replyToMessage.imageUrl || null,
          isFile: newMessage.replyToMessage.isFile || false,
          fileUrl: newMessage.replyToMessage.fileUrl || null,
          fileName: newMessage.replyToMessage.fileName || null,
          fileType: newMessage.replyToMessage.fileType || null,
          createdAt: newMessage.replyToMessage.createdAt
        } : null,
        readBy: newMessage.readBy.map(read => ({
          user: read.user,
          readAt: getThaiTimeISOString(read.readAt),
          _id: read._id
        })),
        createdAt: getThaiTime(newMessage.createdAt),
        isoString: getThaiTimeISOString(newMessage.createdAt),
        success: true
      };
      io.emit('newDirectMessageNotification', notificationData);
    }

    // Format response with Thai time
    const formattedMessage = {
      ...newMessage.toObject(),
      createdAt: getThaiTime(newMessage.createdAt),
      isoString: getThaiTimeISOString(newMessage.createdAt),
      readBy: newMessage.readBy.map(read => ({
        ...read,
        readAt: getThaiTimeISOString(read.readAt)
      })),
      replyToMessage: newMessage.replyToMessage ? {
        ...newMessage.replyToMessage,
        createdAt: getThaiTimeISOString(newMessage.replyToMessage.createdAt)
      } : null,
      sender: userDetails.user ? {
        employeeID: userDetails.user.employeeID,
        fullName: userDetails.user.fullNameThai,
        department: userDetails.user.department,
        imgUrl: userDetails.user.imgUrl || null
      } : null
    };

    res.status(201).json({
      success: true,
      message: 'ส่งรูปภาพสำเร็จ',
      data: formattedMessage
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถส่งรูปภาพได้' });
  }
});

// ส่งไฟล์
router.post('/upload-file', upload.single('file'), async (req, res) => {
  try {
    const { recipientId, message, employeeId, replyToId } = req.body;
    const file = req.file;

    if (!recipientId || !employeeId) {
      return res.status(400).json({ 
        error: 'กรุณาระบุผู้รับและผู้ส่งข้อความ',
        details: { recipientId, employeeId }
      });
    }

    if (!file) {
      return res.status(400).json({ 
        error: 'กรุณาอัพโหลดไฟล์',
        details: { receivedFile: req.file ? req.file.originalname : null }
      });
    }

    // ตรวจสอบว่า recipientId เป็น employee ID ไม่ใช่ Room ID
    if (recipientId.length !== 5) {
      return res.status(400).json({ 
        error: 'Invalid recipient ID format. Please provide a valid employee ID.',
        details: { recipientId }
      });
    }

    // ตรวจสอบผู้ใช้จาก LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ 
        error: 'ไม่พบผู้ใช้งานในระบบ LDAP',
        details: { employeeId }
      });
    }

    // ตรวจสอบผู้รับจาก LDAP
    const recipientDetails = await findUserByEmployeeId(recipientId);
    if (!recipientDetails.success || !recipientDetails.user) {
      return res.status(404).json({ 
        error: 'ไม่พบผู้รับในระบบ LDAP',
        details: { recipientId }
      });
    }

    // สร้าง URL สำหรับไฟล์ (ปรับ path ให้สอดคล้องกับ folder structure ใหม่)
    const [id1, id2] = [employeeId, recipientId].sort();
    const fileUrl = `/uploads/directMessage/${id1}-${id2}/${file.filename}`;

    let newMessage;
    if (replyToId) {
      // สร้างข้อความตอบกลับพร้อมไฟล์
      newMessage = await DirectMessage.createReply({
        participants: [employeeId, recipientId],
        sender: employeeId,
        message: message || '',
        replyToId,
        isFile: true,
        fileUrl,
        fileName: file.originalname,
        fileType: file.mimetype
      });
    } else {
      // สร้างข้อความใหม่พร้อมไฟล์
      newMessage = new DirectMessage({
        participants: [employeeId, recipientId],
        sender: employeeId,
        message: message || '',
        isFile: true,
        fileUrl,
        fileName: file.originalname,
        fileType: file.mimetype
      });
      await newMessage.save();
    }

    // ส่ง WebSocket notification
    const io = req.app.get('io');
    if (io) {
      // ถ้ามี replyToId ให้ดึงข้อมูลผู้ส่งของข้อความที่ตอบกลับ
      let replyToSender = null;
      if (replyToId) {
        const replyMessage = await DirectMessage.findById(replyToId);
        if (replyMessage) {
          const replySenderDetails = await findUserByEmployeeId(replyMessage.sender);
          if (replySenderDetails.success && replySenderDetails.user) {
            replyToSender = {
              employeeID: replySenderDetails.user.employeeID,
              fullName: replySenderDetails.user.fullNameThai,
              department: replySenderDetails.user.department,
              imgUrl: replySenderDetails.user.imgUrl || null
            };
          }
        }
      }

      const socketData = {
        _id: newMessage._id,
        participants: newMessage.participants,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullNameThai,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        isRead: false,
        isFile: true,
        fileUrl: newMessage.fileUrl,
        fileName: newMessage.fileName,
        fileType: newMessage.fileType,
        replyTo: newMessage.replyTo || null,
        replyToMessage: newMessage.replyToMessage ? {
          messageId: newMessage.replyToMessage._id,
          sender: replyToSender,
          message: newMessage.replyToMessage.message,
          isImage: newMessage.replyToMessage.isImage || false,
          imageUrl: newMessage.replyToMessage.imageUrl || null,
          isFile: newMessage.replyToMessage.isFile || false,
          fileUrl: newMessage.replyToMessage.fileUrl || null,
          fileName: newMessage.replyToMessage.fileName || null,
          fileType: newMessage.replyToMessage.fileType || null,
          createdAt: newMessage.replyToMessage.createdAt
        } : null,
        readBy: newMessage.readBy.map(read => ({
          user: read.user,
          readAt: getThaiTimeISOString(read.readAt),
          _id: read._id
        })),
        createdAt: getThaiTime(newMessage.createdAt),
        isoString: getThaiTimeISOString(newMessage.createdAt),
        success: true
      };

      // ส่งข้อความไปยังผู้รับ
      io.to(recipientId).emit('newDirectMessage', socketData);

      // ส่ง notification
      const notificationData = {
        _id: newMessage._id,
        participants: newMessage.participants,
        recipientId,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullNameThai,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        isRead: false,
        isFile: true,
        fileUrl: newMessage.fileUrl,
        fileName: newMessage.fileName,
        fileType: newMessage.fileType,
        replyTo: newMessage.replyTo || null,
        replyToMessage: newMessage.replyToMessage ? {
          messageId: newMessage.replyToMessage._id,
          sender: replyToSender,
          message: newMessage.replyToMessage.message,
          isImage: newMessage.replyToMessage.isImage || false,
          imageUrl: newMessage.replyToMessage.imageUrl || null,
          isFile: newMessage.replyToMessage.isFile || false,
          fileUrl: newMessage.replyToMessage.fileUrl || null,
          fileName: newMessage.replyToMessage.fileName || null,
          fileType: newMessage.replyToMessage.fileType || null,
          createdAt: newMessage.replyToMessage.createdAt
        } : null,
        readBy: newMessage.readBy.map(read => ({
          user: read.user,
          readAt: getThaiTimeISOString(read.readAt),
          _id: read._id
        })),
        createdAt: getThaiTime(newMessage.createdAt),
        isoString: getThaiTimeISOString(newMessage.createdAt),
        success: true
      };
      io.emit('newDirectMessageNotification', notificationData);
    }

    // Format response with Thai time
    const formattedMessage = {
      ...newMessage.toObject(),
      createdAt: getThaiTime(newMessage.createdAt),
      isoString: getThaiTimeISOString(newMessage.createdAt),
      readBy: newMessage.readBy.map(read => ({
        ...read,
        readAt: getThaiTimeISOString(read.readAt)
      })),
      replyToMessage: newMessage.replyToMessage ? {
        ...newMessage.replyToMessage,
        createdAt: getThaiTimeISOString(newMessage.replyToMessage.createdAt)
      } : null,
      sender: userDetails.user ? {
        employeeID: userDetails.user.employeeID,
        fullName: userDetails.user.fullNameThai,
        department: userDetails.user.department,
        imgUrl: userDetails.user.imgUrl || null
      } : null
    };

    res.status(201).json({
      success: true,
      message: 'ส่งไฟล์สำเร็จ',
      data: formattedMessage
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถส่งไฟล์ได้' });
  }
});

// ดึงประวัติการสนทนา
router.get('/conversation/:participantId', async (req, res) => {
  try {
    const { participantId } = req.params;
    const { employeeId, page = 1, limit = 20 } = req.query;

    if (!employeeId) {
      return res.status(400).json({ error: 'กรุณาระบุผู้ใช้' });
    }

    // ตรวจสอบผู้ใช้จาก LDAP
    const userDetails = await findUserByEmployeeId(participantId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้งานในระบบ LDAP' });
    }

    const messages = await DirectMessage.find({
      participants: { $all: [employeeId, participantId] }
    })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

    // อัพเดทสถานะการอ่านสำหรับข้อความที่ยังไม่ได้อ่าน
    const unreadMessages = messages.filter(msg => 
      !msg.isRead && msg.sender !== employeeId
    );

    if (unreadMessages.length > 0) {
      await DirectMessage.updateMany(
        {
          _id: { $in: unreadMessages.map(msg => msg._id) },
          'readBy.user': { $ne: employeeId }
        },
        {
          $set: { isRead: true },
          $push: {
            readBy: {
              user: employeeId,
              readAt: new Date()
            }
          }
        }
      );
    }

    // ดึงข้อมูลผู้ส่งสำหรับแต่ละข้อความ
    const senderIds = [...new Set(messages.map(msg => msg.sender))];
    const userPromises = senderIds.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // จัดรูปแบบข้อความพร้อมข้อมูลผู้ส่งและเวลาไทย
    const formattedMessages = messages.map(msg => {
      const messageObj = msg.toObject();
      return {
        ...messageObj,
        createdAt: getThaiTime(messageObj.createdAt),
        isoString: getThaiTimeISOString(messageObj.createdAt),
        readBy: messageObj.readBy.map(read => ({
          ...read,
          readAt: getThaiTimeISOString(read.readAt)
        })),
        replyToMessage: messageObj.replyToMessage ? {
          messageId: messageObj.replyToMessage._id,
          sender: userMap[messageObj.replyToMessage.sender] ? {
            employeeID: userMap[messageObj.replyToMessage.sender].employeeID,
            fullName: userMap[messageObj.replyToMessage.sender].fullNameThai,
            department: userMap[messageObj.replyToMessage.sender].department,
            imgUrl: userMap[messageObj.replyToMessage.sender].imgUrl || null
          } : null,
          message: messageObj.replyToMessage.message,
          isImage: messageObj.replyToMessage.isImage || false,
          imageUrl: messageObj.replyToMessage.imageUrl || null,
          isFile: messageObj.replyToMessage.isFile || false,
          fileUrl: messageObj.replyToMessage.fileUrl || null,
          fileName: messageObj.replyToMessage.fileName || null,
          fileType: messageObj.replyToMessage.fileType || null,
          createdAt: messageObj.replyToMessage.createdAt
        } : null,
        sender: userMap[messageObj.sender] ? {
          employeeID: userMap[messageObj.sender].employeeID,
          fullName: userMap[messageObj.sender].fullNameThai,
          department: userMap[messageObj.sender].department,
          imgUrl: userMap[messageObj.sender].imgUrl || null
        } : null
      };
    });

    res.json({
      success: true,
      data: formattedMessages.reverse()
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถดึงประวัติการสนทนาได้' });
  }
});

// ดึงรายการสนทนาล่าสุด
router.get('/conversations', async (req, res) => {
  try {
    const { employeeId } = req.query;

    if (!employeeId) {
      return res.status(400).json({ error: 'กรุณาระบุผู้ใช้' });
    }

    // ค้นหาข้อความล่าสุดของแต่ละการสนทนา
    const conversations = await DirectMessage.aggregate([
      {
        $match: {
          participants: employeeId
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $filter: {
              input: '$participants',
              as: 'participant',
              cond: { $ne: ['$$participant', employeeId] }
            }
          },
          lastMessage: { $first: '$$ROOT' }
        }
      },
      {
        $project: {
          participantId: { $arrayElemAt: ['$_id', 0] },
          lastMessage: 1,
          _id: 0
        }
      }
    ]);

    // ดึงข้อมูลผู้ใช้สำหรับแต่ละการสนทนา
    const participantIds = conversations.map(conv => conv.participantId);
    const userPromises = participantIds.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // จัดรูปแบบการสนทนาพร้อมข้อมูลผู้ใช้และเวลาไทย
    const formattedConversations = conversations.map(conv => {
      const participant = userMap[conv.participantId];
      const lastMessage = conv.lastMessage;
      return {
        ...conv,
        participant: participant ? {
          employeeID: participant.employeeID,
          fullName: participant.fullNameThai,
          department: participant.department,
          imgUrl: participant.imgUrl || null
        } : null,
        lastMessage: {
          ...lastMessage,
          createdAt: formatThaiDateTimeDirectMessage(lastMessage.createdAt),
          isoString: getThaiTimeISOString(lastMessage.createdAt),
          replyToMessage: lastMessage.replyToMessage ? {
            ...lastMessage.replyToMessage,
            createdAt: formatThaiDateTime(lastMessage.replyToMessage.createdAt)
          } : null,
          sender: userMap[lastMessage.sender] ? {
            employeeID: userMap[lastMessage.sender].employeeID,
            fullName: userMap[lastMessage.sender].fullName,
            department: userMap[lastMessage.sender].department,
            imgUrl: userMap[lastMessage.sender].imgUrl || null
          } : null
        }
      };
    });

    res.json({
      success: true,
      data: formattedConversations
    });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถดึงรายการสนทนาได้' });
  }
});

// อัพเดทสถานะการอ่าน
router.post('/mark-read', async (req, res) => {
  try {
    const { messageIds, employeeId } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0 || !employeeId) {
      return res.status(400).json({ error: 'กรุณาระบุข้อความและผู้ใช้ที่ต้องการอัพเดท' });
    }

    const messages = await DirectMessage.updateMany(
      {
        _id: { $in: messageIds },
        participants: employeeId,
        sender: { $ne: employeeId }
      },
      {
        $set: { isRead: true },
        $push: {
          readBy: {
            user: employeeId,
            readAt: new Date()
          }
        }
      }
    );

    // Get updated messages with full details
    const updatedMessages = await DirectMessage.find({
      _id: { $in: messageIds }
    });

    // Get sender details for all messages
    const senderIds = [...new Set(updatedMessages.map(msg => msg.sender))];
    const userPromises = senderIds.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // Format messages with Thai time
    const formattedMessages = updatedMessages.map(msg => ({
      ...msg.toObject(),
      createdAt: getThaiTime(msg.createdAt),
      isoString: getThaiTimeISOString(msg.createdAt),
      readBy: msg.readBy.map(read => ({
        ...read,
        readAt: getThaiTimeISOString(read.readAt)
      })),
      replyToMessage: msg.replyToMessage ? {
        ...msg.replyToMessage,
        createdAt: getThaiTimeISOString(msg.replyToMessage.createdAt)
      } : null,
      sender: userMap[msg.sender] ? {
        employeeID: userMap[msg.sender].employeeID,
        fullName: userMap[msg.sender].fullName,
        department: userMap[msg.sender].department,
        imgUrl: userMap[msg.sender].imgUrl || null
      } : null
    }));

    // Send WebSocket notifications
    const io = req.app.get('io');
    if (io) {
      for (const senderId of senderIds) {
        if (senderId !== employeeId) {
          const readerDetails = await findUserByEmployeeId(employeeId);
          if (readerDetails.success && readerDetails.user) {
            io.to(senderId).emit('directMessagesRead', {
              messageIds,
              readBy: {
                employeeID: readerDetails.user.employeeID,
                fullName: readerDetails.user.fullName,
                department: readerDetails.user.department,
                imgUrl: readerDetails.user.imgUrl || null
              },
              timestamp: getThaiTime(new Date()),
              isoString: getThaiTimeISOString(new Date())
            });
          }
        }
      }
    }

    res.json({
      success: true,
      message: 'อัพเดทสถานะการอ่านสำเร็จ',
      data: formattedMessages
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถอัพเดทสถานะการอ่านได้' });
  }
});

// ลบข้อความ
router.delete('/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { employeeId } = req.query;

    if (!employeeId) {
      return res.status(400).json({ error: 'กรุณาระบุผู้ใช้' });
    }

    const message = await DirectMessage.findOne({
      _id: messageId,
      sender: employeeId
    });

    if (!message) {
      return res.status(404).json({ error: 'ไม่พบข้อความหรือไม่มีสิทธิ์ลบ' });
    }

    // ส่ง WebSocket notification ไปยังผู้รับ
    const recipientId = message.participants.find(id => id !== employeeId);
    const io = req.app.get('io');
    
    if (io && recipientId) {
      const deleterDetails = await findUserByEmployeeId(employeeId);
      if (deleterDetails.success && deleterDetails.user) {
        io.to(recipientId).emit('directMessageDeleted', {
          messageId,
          deletedBy: {
            employeeID: deleterDetails.user.employeeID,
            fullName: deleterDetails.user.fullName,
            department: deleterDetails.user.department,
            imgUrl: deleterDetails.user.imgUrl || null
          },
          timestamp: getThaiTime(new Date()),
          isoString: getThaiTimeISOString(new Date())
        });
      }
    }

    // Format deleted message with Thai time
    const formattedMessage = {
      ...message.toObject(),
      createdAt: getThaiTime(message.createdAt),
      isoString: getThaiTimeISOString(message.createdAt),
      readBy: message.readBy.map(read => ({
        ...read,
        readAt: getThaiTimeISOString(read.readAt)
      })),
      replyToMessage: message.replyToMessage ? {
        ...message.replyToMessage,
        createdAt: getThaiTimeISOString(message.replyToMessage.createdAt)
      } : null
    };

    await message.deleteOne();

    res.json({
      success: true,
      message: 'ลบข้อความสำเร็จ',
      data: formattedMessage
    });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถลบข้อความได้' });
  }
});

module.exports = router; 
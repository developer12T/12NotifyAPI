const express = require('express');
const router = express.Router();
const DirectMessage = require('../models/DirectMessage');
const { findUserByEmployeeId } = require('../services/ldapServices');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

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
      const socketData = {
        _id: newMessage._id,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullName,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        timestamp: newMessage.createdAt,
        isRead: false,
        replyTo: newMessage.replyTo,
        replyToMessage: newMessage.replyToMessage,
        success: true
      };

      // ส่งข้อความไปยังผู้รับ
      io.to(recipientId).emit('newDirectMessage', socketData);

      // ส่ง notification
      const notificationData = {
        recipientId,
        message: newMessage.message,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullName,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        timestamp: newMessage.createdAt
      };
      io.emit('newDirectMessageNotification', notificationData);
    }

    res.status(201).json({
      success: true,
      message: 'ส่งข้อความสำเร็จ',
      data: newMessage
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
      return res.status(400).json({ error: 'กรุณาระบุผู้รับและผู้ส่งข้อความ' });
    }

    if (!image) {
      return res.status(400).json({ error: 'กรุณาอัพโหลดรูปภาพ' });
    }

    // ตรวจสอบผู้ใช้จาก LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้งานในระบบ LDAP' });
    }

    // TODO: อัพโหลดรูปภาพไปยัง storage service
    const imageUrl = 'https://example.com/image.jpg'; // แทนที่ด้วย URL จริง

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
      const socketData = {
        _id: newMessage._id,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullName,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        timestamp: newMessage.createdAt,
        isRead: false,
        isImage: true,
        imageUrl: newMessage.imageUrl,
        replyTo: newMessage.replyTo,
        replyToMessage: newMessage.replyToMessage,
        success: true
      };

      // ส่งข้อความไปยังผู้รับ
      io.to(recipientId).emit('newDirectMessage', socketData);

      // ส่ง notification
      const notificationData = {
        recipientId,
        message: message || 'ส่งรูปภาพ',
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullName,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        isImage: true,
        imageUrl: newMessage.imageUrl,
        timestamp: newMessage.createdAt
      };
      io.emit('newDirectMessageNotification', notificationData);
    }

    res.status(201).json({
      success: true,
      message: 'ส่งรูปภาพสำเร็จ',
      data: newMessage
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
      return res.status(400).json({ error: 'กรุณาระบุผู้รับและผู้ส่งข้อความ' });
    }

    if (!file) {
      return res.status(400).json({ error: 'กรุณาอัพโหลดไฟล์' });
    }

    // ตรวจสอบผู้ใช้จาก LDAP
    const userDetails = await findUserByEmployeeId(employeeId);
    if (!userDetails.success || !userDetails.user) {
      return res.status(404).json({ error: 'ไม่พบผู้ใช้งานในระบบ LDAP' });
    }

    // TODO: อัพโหลดไฟล์ไปยัง storage service
    const fileUrl = 'https://example.com/file.pdf'; // แทนที่ด้วย URL จริง

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
      const socketData = {
        _id: newMessage._id,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullName,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        message: newMessage.message,
        timestamp: newMessage.createdAt,
        isRead: false,
        isFile: true,
        fileUrl: newMessage.fileUrl,
        fileName: newMessage.fileName,
        fileType: newMessage.fileType,
        replyTo: newMessage.replyTo,
        replyToMessage: newMessage.replyToMessage,
        success: true
      };

      // ส่งข้อความไปยังผู้รับ
      io.to(recipientId).emit('newDirectMessage', socketData);

      // ส่ง notification
      const notificationData = {
        recipientId,
        message: message || `ส่งไฟล์ ${file.originalname}`,
        sender: {
          employeeID: userDetails.user.employeeID,
          fullName: userDetails.user.fullName,
          department: userDetails.user.department,
          imgUrl: userDetails.user.imgUrl || null
        },
        isFile: true,
        fileUrl: newMessage.fileUrl,
        fileName: newMessage.fileName,
        fileType: newMessage.fileType,
        timestamp: newMessage.createdAt
      };
      io.emit('newDirectMessageNotification', notificationData);
    }

    res.status(201).json({
      success: true,
      message: 'ส่งไฟล์สำเร็จ',
      data: newMessage
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

    // จัดรูปแบบข้อความพร้อมข้อมูลผู้ส่ง
    const formattedMessages = messages.map(msg => ({
      ...msg.toObject(),
      sender: userMap[msg.sender] ? {
        employeeID: userMap[msg.sender].employeeID,
        fullName: userMap[msg.sender].fullName,
        department: userMap[msg.sender].department,
        imgUrl: userMap[msg.sender].imgUrl || null
      } : null
    }));

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

    // จัดรูปแบบการสนทนาพร้อมข้อมูลผู้ใช้
    const formattedConversations = conversations.map(conv => {
      const participant = userMap[conv.participantId];
      return {
        ...conv,
        participant: participant ? {
          employeeID: participant.employeeID,
          fullName: participant.fullName,
          department: participant.department,
          imgUrl: participant.imgUrl || null
        } : null,
        lastMessage: {
          ...conv.lastMessage,
          sender: userMap[conv.lastMessage.sender] ? {
            employeeID: userMap[conv.lastMessage.sender].employeeID,
            fullName: userMap[conv.lastMessage.sender].fullName,
            department: userMap[conv.lastMessage.sender].department,
            imgUrl: userMap[conv.lastMessage.sender].imgUrl || null
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

    // ส่ง WebSocket notification ไปยังผู้ส่ง
    const updatedMessages = await DirectMessage.find({
      _id: { $in: messageIds }
    }).select('sender');

    const senderIds = [...new Set(updatedMessages.map(msg => msg.sender))];
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
              timestamp: new Date()
            });
          }
        }
      }
    }

    res.json({
      success: true,
      message: 'อัพเดทสถานะการอ่านสำเร็จ',
      data: messages
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
          timestamp: new Date()
        });
      }
    }

    await message.deleteOne();

    res.json({
      success: true,
      message: 'ลบข้อความสำเร็จ'
    });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: error.message || 'ไม่สามารถลบข้อความได้' });
  }
});

module.exports = router; 
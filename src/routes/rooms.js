const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const Room = require('../models/Room');
const User = require('../models/User');
const { getThaiTime, getThaiTimeISOString, formatThaiDateTime } = require('../utils/timeUtils');
const Message = require('../models/Message');
const Employee = require('../models/User');
const { findUserByEmployeeId } = require('../services/ldapServices');
const Bot = require('../models/Bot');
const Announcement = require('../models/Announcement');

// Configure multer for image upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/rooms') // Make sure this directory exists
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
        cb(null, 'room-' + uniqueSuffix + path.extname(file.originalname))
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Accept images only
        if (!file.originalname.match(/\.(jpg|jpeg|png|gif)$/)) {
            return cb(new Error('Only image files are allowed!'), false);
        }
        cb(null, true);
    }
});

// Create new room
router.post('/', upload.single('image'), async (req, res) => {
  try {
    let { name, description, color, admin, members } = req.body;
    
    // Parse JSON strings back to objects
    admin = JSON.parse(admin);
    members = members ? JSON.parse(members) : [];

    // Get image URL if file was uploaded
    const imageUrl = req.file ? `/uploads/rooms/${req.file.filename}` : null;

    // Add admin to members list with admin role
    const allMembers = [
      { empId: admin.empId, role: 'admin' },
      ...(members || [])
    ];

    const unreadCounts = allMembers.map(member => ({
      user: member.empId,
      count: 0
    }));

    const room = new Room({
      name,
      description,
      color: color || '#007bff',
      members: allMembers,
      lastMessage: null,
      unreadCounts,
      imageUrl
    });

    await room.save();

    res.status(201).json(room);
  } catch (error) {
    // If there's an error and a file was uploaded, we should clean it up
    if (req.file) {
      const fs = require('fs');
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }
    res.status(500).json({ message: error.message });
  }
});

router.get('/summary', async (req, res) => {
  try {
    // 1. Users
    const userTotal = await User.countDocuments();
    const userMax = 500; // สมมติเป็นค่าคงที่

    // 2. Groups (Rooms)
    const groupTotal = await Room.countDocuments();

    // 3. Announcements
    const announcementTotal = await Announcement.countDocuments();

    // 4. Recent Activities (ตัวอย่าง: ประกาศใหม่, ผู้ใช้ใหม่, กลุ่มใหม่, อัปเดตระบบ)
    // สมมติว่ามี collection สำหรับกิจกรรม หรือดึงจากหลาย collection แล้วรวมกัน
    // ตัวอย่างนี้ดึง 2 รายการล่าสุดจากแต่ละ collection แล้วรวมเรียงตามวันที่

    const recentAnnouncements = await Announcement.find({})
      .sort({ createdAt: -1 })
      .limit(2)
      .lean();

    const recentUsers = await User.find({})
      .sort({ createdAt: -1 })
      .limit(2)
      .lean();

    const recentGroups = await Room.find({})
      .sort({ createdAt: -1 })
      .limit(2)
      .lean();

    // รวมกิจกรรม
    let recent_activities = [
      ...recentAnnouncements.map(a => ({
        type: "announcement",
        title: a.title || "ประกาศใหม่",
        description: a.description || "",
        time_ago: getThaiTime(a.createdAt) // สมมติว่ามีฟังก์ชันนี้
      })),
      ...recentUsers.map(u => ({
        type: "user_register",
        title: "ผู้ใช้งานใหม่ลงทะเบียน",
        description: `สมาชิกใหม่ ${u.fullName || u.username || ''}`,
        time_ago: getThaiTime(u.createdAt)
      })),
      ...recentGroups.map(g => ({
        type: "group_create",
        title: "กลุ่มแชทใหม่ถูกสร้าง",
        description: `กลุ่ม '${g.name}' ถูกสร้าง`,
        time_ago: getThaiTime(g.createdAt)
      }))
    ];

    // เรียงตามวันที่ล่าสุด
    recent_activities = recent_activities
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 4); // เอาแค่ 4 รายการ

    res.json({
      users: { total: userTotal, max: userMax },
      groups: { total: groupTotal },
      announcements: { total: announcementTotal },
      recent_activities
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Add member to room
router.post('/:roomId/members', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { members, empId, role } = req.body;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }

    // Handle both single member and multiple members
    const membersToAdd = Array.isArray(members) ? members : [{ empId, role }];

    if (membersToAdd.length === 0) {
      return res.status(400).json({
        statusCode: 400,
        message: 'กรุณาระบุรายชื่อสมาชิกที่ต้องการเพิ่ม'
      });
    }

    // Validate each member data
    const invalidMembers = membersToAdd.filter(member => !member.empId || !member.role);
    if (invalidMembers.length > 0) {
      return res.status(400).json({
        statusCode: 400,
        message: 'ข้อมูลสมาชิกไม่ถูกต้อง กรุณาระบุ empId และ role ให้ครบถ้วน'
      });
    }

    // Check for duplicate members
    const existingMemberIds = new Set(room.members.map(m => m.empId));
    const duplicateMembers = membersToAdd.filter(m => existingMemberIds.has(m.empId));
    
    if (duplicateMembers.length > 0) {
      return res.status(400).json({
        statusCode: 400,
        message: 'มีสมาชิกบางรายอยู่ในห้องแล้ว',
        duplicateMembers: duplicateMembers.map(m => m.empId)
      });
    }

    // Add new members
    const newMembers = membersToAdd.map(member => ({
      empId: member.empId,
      role: member.role
    }));

    // Add unreadCounts for new members
    const newUnreadCounts = membersToAdd.map(member => ({
      user: member.empId,
      count: 0
    }));

    // Update room with new members
    room.members.push(...newMembers);
    room.unreadCounts.push(...newUnreadCounts);
    await room.save();

    // Get user details for new members
    const userPromises = membersToAdd
      .filter(member => member.role !== 'bot')
      .map(member => findUserByEmployeeId(member.empId));
    const userResults = await Promise.all(userPromises);

    // Get bot details for new bot members
    const botPromises = membersToAdd
      .filter(member => member.role === 'bot')
      .map(member => Bot.findOne({ employeeID: member.empId }));
    const botResults = await Promise.all(botPromises);
    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = bot;
      }
      return map;
    }, {});

    // Format added members with their details
    const addedMembers = membersToAdd.map(member => {
      if (member.role === 'bot') {
        const botDetails = botMap[member.empId];
        return {
          employeeID: member.empId,
          fullName: botDetails?.name || 'Unknown Bot',
          department: 'bot notify',
          profileImage: null,
          role: member.role,
          isAdmin: false
        };
      } else {
        const userResult = userResults.find(result => 
          result.success && result.user.employeeID === member.empId
        );
        const user = userResult?.user;
        return {
          employeeID: member.empId,
          fullName: user?.fullName || 'Unknown User',
          department: user?.department || 'Unknown Department',
          profileImage: user?.profileImage || null,
          role: member.role,
          isAdmin: false
        };
      }
    });

    // Notify room members through socket about new members
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('membersAdded', {
        roomId,
        newMembers: addedMembers,
        timestamp: new Date()
      });
    }

    res.json({
      statusCode: 200,
      message: 'เพิ่มสมาชิกสำเร็จ',
      data: {
        addedMembers,
        totalMemberCount: room.members.length
      }
    });
  } catch (error) {
    console.error('Error adding members:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการเพิ่มสมาชิก',
      error: error.message 
    });
  }
});

// Remove member from room
router.delete('/:roomId/members/:userId', async (req, res) => {
  try {
    const { roomId, userId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }

    // Check if user is admin
    const member = room.members.find(m => m.empId === userId);
    if (member && member.role === 'admin') {
      return res.status(400).json({
        statusCode: 400,
        message: 'ไม่สามารถลบ admin ออกจากห้องได้'
      });
    }

    // Check if user is a member
    if (!member) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบสมาชิกในห้องนี้'
      });
    }

    // Remove user from members array
    room.members = room.members.filter(
      member => member.empId !== userId
    );

    // Remove user's unread count
    room.unreadCounts = room.unreadCounts.filter(
      count => count.user !== userId
    );

    await room.save();

    // Get user details for notification
    const userResult = await findUserByEmployeeId(userId);
    const removedUser = userResult.success ? userResult.user : null;

    // Notify room members through socket
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('memberRemoved', {
        roomId,
        removedMember: removedUser ? {
          employeeID: removedUser.employeeID,
          fullName: removedUser.fullName,
          department: removedUser.department,
          profileImage: removedUser.profileImage
        } : null,
        timestamp: new Date()
      });
    }

    res.json({
      statusCode: 200,
      message: 'ลบสมาชิกออกจากห้องสำเร็จ',
      data: {
        removedMemberId: userId,
        totalMemberCount: room.members.length
      }
    });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการลบสมาชิก',
      error: error.message 
    });
  }
});

// Get all rooms for an employee
router.get('/employee/:empId', async (req, res) => {
  try {
    const { empId } = req.params;

    // Get rooms where empId is a member
    const rooms = await Room.find({
      'members.empId': empId
    });

    // Get last message for each room
    const roomPromises = rooms.map(async (room) => {
      const lastMessage = await Message.findOne({ room: room._id })
        .sort({ createdAt: -1 })
        .limit(1);

      return {
        room,
        lastMessage
      };
    });

    const roomsWithLastMessage = await Promise.all(roomPromises);

    // Sort rooms by last message timestamp
    roomsWithLastMessage.sort((a, b) => {
      if (!a.lastMessage && !b.lastMessage) return 0;
      if (!a.lastMessage) return 1;
      if (!b.lastMessage) return -1;
      return b.lastMessage.createdAt - a.lastMessage.createdAt;
    });

    // Get unique sender IDs from last messages
    const senderIds = roomsWithLastMessage
      .filter(item => item.lastMessage)
      .map(item => item.lastMessage.sender);
    
    // Get user details for all senders using LDAP
    const userPromises = senderIds.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // Get bot details for all rooms
    const botMemberIds = rooms.reduce((ids, room) => {
      const botMembers = room.members.filter(member => member.role === 'bot');
      return [...ids, ...botMembers.map(member => member.empId)];
    }, []);
    const uniqueBotIds = [...new Set(botMemberIds)];
    
    const botPromises = uniqueBotIds.map(id => Bot.findOne({ employeeID: id }));
    const botResults = await Promise.all(botPromises);
    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = bot;
      }
      return map;
    }, {});

    // Format response
    const formattedRooms = roomsWithLastMessage.map(({ room, lastMessage }) => {
      const unreadCount = room.unreadCounts.find(
        count => count.user === empId
      )?.count || 0;

      // Get user's role in this room
      const userRole = room.members.find(
        member => member.empId === empId
      )?.role || null;

      // Get admin of the room
      const admin = room.members.find(member => member.role === 'admin');

      // Get sender details for lastMessage
      const lastMessageSender = lastMessage?.sender ? 
        (userMap[lastMessage.sender] || botMap[lastMessage.sender]) : null;

      // Format lastMessage with all required fields
      const formattedLastMessage = lastMessage ? {
        message: lastMessage.message || '',
        sender: lastMessageSender ? {
          employeeID: lastMessageSender.employeeID,
          fullName: lastMessageSender.role === 'bot' ? 
            lastMessageSender.name : 
            lastMessageSender.fullName,
          department: lastMessageSender.role === 'bot' ? 
            'bot notify' : 
            lastMessageSender.department,
          profileImage: lastMessageSender.profileImage || null,
          role: lastMessageSender.role
        } : null,
        timestamp: lastMessage.createdAt,
        isoString: getThaiTimeISOString(lastMessage.createdAt)
      } : null;

      return {
        id: room._id,
        name: room.name,
        description: room.description,
        imageUrl: room.imageUrl,
        color: room.color,
        admin: admin ? admin.empId : null,
        adminRole: admin ? admin.role : null,
        userRole,
        lastMessage: formattedLastMessage,
        unreadCount,
        memberCount: room.members.length
      };
    });

    res.json({
      statusCode: 200,
      data: formattedRooms
    });
  } catch (error) {
    console.error('Error getting employee rooms:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลห้องแชท',
      error: error.message 
    });
  }
});

router.get('/web', async (req, res) => {
  try {
    // Get rooms with selected fields
    const rooms = await Room.find({},{
      '_id': 1,
      'name': 1,
      'description': 1,
      'color': 1,
      'members': 1,
      'isActive': 1,
      'createdAt': 1,
      'updatedAt': 1
    });

    // Get admin details from LDAP for each room
    const adminPromises = rooms.map(room => {
      const admin = room.members.find(m => m.role === 'admin');
      return admin ? findUserByEmployeeId(admin.empId) : Promise.resolve({ success: false });
    });
    const adminResults = await Promise.all(adminPromises);
    
    const adminMap = adminResults.reduce((map, result, index) => {
      if (result.success && result.user) {
        const room = rooms[index];
        const admin = room.members.find(m => m.role === 'admin');
        if (admin) {
          map[admin.empId] = result.user;
        }
      }
      return map;
    }, {});

    // Get all member IDs with role "owner" from all rooms
    const userMemberIds = rooms.reduce((ids, room) => {
      const userMembers = room.members.filter(member => member.role === 'owner');
      return [...ids, ...userMembers.map(member => member.empId)];
    }, []);

    // Get unique member IDs
    const uniqueUserMemberIds = [...new Set(userMemberIds)];

    // Get user details from LDAP for all members
    const memberPromises = uniqueUserMemberIds.map(id => findUserByEmployeeId(id));
    const memberResults = await Promise.all(memberPromises);
    
    const memberMap = memberResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // Get bot details for all rooms
    const botMemberIds = rooms.reduce((ids, room) => {
      const botMembers = room.members.filter(member => member.role === 'bot');
      return [...ids, ...botMembers.map(member => member.empId)];
    }, []);
    const uniqueBotIds = [...new Set(botMemberIds)];
    
    const botPromises = uniqueBotIds.map(id => Bot.findOne({ employeeID: id }));
    const botResults = await Promise.all(botPromises);
    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = bot;
      }
      return map;
    }, {});

    // Format rooms with admin and filtered members details
    const formattedRooms = rooms.map(room => {
      const admin = room.members.find(m => m.role === 'admin');
      const adminDetails = admin ? adminMap[admin.empId] : null;
      
      // Format all members (both users and bots)
      const formattedMembers = room.members.map(member => {
        if (member.role === 'bot') {
          const botDetails = botMap[member.empId];
          return {
            employeeID: member.empId,
            fullName: botDetails?.name || 'Unknown Bot',
            department: 'bot notify',
            role: member.role
          };
        } else if (member.role === 'owner') {
          const userDetails = memberMap[member.empId];
          return {
            employeeID: member.empId,
            fullName: userDetails?.fullName || 'Unknown User',
            department: userDetails?.department || 'Unknown Department',
            role: member.role
          };
        }
        return null;
      }).filter(Boolean); // Remove null entries

      // Calculate total members
      const totalMembers = room.members.length;

      return {
        ...room.toObject(),
        admin: adminDetails ? {
          employeeID: adminDetails.employeeID,
          fullName: adminDetails.fullName,
          department: adminDetails.department,
          role: admin.role
        } : null,
        members: formattedMembers,
        totalMembers,
        createdAt: formatThaiDateTime(room.createdAt),
        updatedAt: formatThaiDateTime(room.updatedAt)
      };
    });
    
    res.json({
      statusCode: 200,
      data: formattedRooms
    });
  } catch (error) {
    console.error('Error getting employee rooms:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลห้องแชท',
      error: error.message 
    });
  }
});

// Get room members
router.get('/:roomId/members', async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({ 
        statusCode: 404,
        message: 'ไม่พบห้องแชท' 
      });
    }

    // Get all member IDs
    const memberIds = room.members.map(m => m.empId);

    // Get user details for all members using LDAP
    const userPromises = memberIds.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    // Create a map of user details
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // Get bot details for members with role 'bot'
    const botPromises = room.members
      .filter(member => member.role === 'bot')
      .map(member => Bot.findOne({ employeeID: member.empId }));
    const botResults = await Promise.all(botPromises);
    
    // Create a map of bot details
    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = bot;
      }
      return map;
    }, {});

    // Format members with their roles and details
    const formattedMembers = room.members.map(member => {
      const user = userMap[member.empId];
      const isBot = member.role === 'bot';
      const botDetails = isBot ? botMap[member.empId] : null;
      const isAdmin = member.role === 'admin';

      return {
        employeeID: member.empId,
        fullName: isBot ? (botDetails?.name || 'Unknown Bot') : (user?.fullName || 'Unknown User'),
        department: isBot ? 'bot notify' : (user?.department || 'Unknown Department'),
        profileImage: user?.profileImage || null,
        role: member.role,
        isAdmin: isAdmin
      };
    });

    res.json({
      statusCode: 200,
      members: formattedMembers
    });
  } catch (error) {
    console.error('Error getting room members:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลสมาชิก',
      error: error.message 
    });
  }
});

// Mark room as read
router.post('/notifications/read/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        statusCode: 400,
        message: 'User ID is required'
      });
    }

    // Update room's unread count for the user
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        statusCode: 404,
        message: 'Room not found'
      });
    }

    // Reset unread count for the user
    await Room.updateOne(
      { _id: roomId },
      { 
        $set: { 
          'unreadCounts.$[elem].count': 0 
        }
      },
      { 
        arrayFilters: [{ 'elem.user': userId }]
      }
    );

    // Mark all messages in the room as read for this user
    await Message.updateMany(
      { 
        room: roomId,
        sender: { $ne: userId },
        isRead: false
      },
      { 
        $set: { isRead: true },
        $push: { 
          readBy: { 
            user: userId,
            readAt: new Date()
          }
        }
      }
    );

    // Notify others in room through socket
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('unreadCountUpdate', {
        roomId,
        userId,
        count: 0,
        timestamp: new Date()
      });
    }

    res.json({
      statusCode: 200,
      message: 'Room marked as read successfully'
    });
  } catch (error) {
    console.error('Error marking room as read:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดทสถานะการอ่าน',
      error: error.message
    });
  }
});

// Get room details
router.get('/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบห้องแชท'
      });
    }

    // Get all member IDs
    const memberIds = room.members.map(m => m.empId);

    // Get user details for all members using LDAP
    const userPromises = memberIds.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    // Create a map of user details
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    // Get bot details for members with role 'bot'
    const botPromises = room.members
      .filter(member => member.role === 'bot')
      .map(member => Bot.findOne({ employeeID: member.empId }));
    const botResults = await Promise.all(botPromises);
    
    // Create a map of bot details
    const botMap = botResults.reduce((map, bot) => {
      if (bot) {
        map[bot.employeeID] = bot;
      }
      return map;
    }, {});

    // Format members with their roles and details
    const formattedMembers = room.members.map(member => {
      const user = userMap[member.empId];
      const isBot = member.role === 'bot';
      const botDetails = isBot ? botMap[member.empId] : null;
      const isAdmin = member.role === 'admin';

      return {
        employeeID: member.empId,
        fullName: isBot ? (botDetails?.name || 'Unknown Bot') : (user?.fullName || 'Unknown User'),
        department: isBot ? 'bot notify' : (user?.department || 'Unknown Department'),
        profileImage: `http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/${member.empId}.jpg` || null,
        role: member.role,
        isAdmin: isAdmin
      };
    });

    // Format response
    const formattedRoom = {
      id: room._id,
      name: room.name,
      description: room.description,
      color: room.color,
      imageUrl: room.imageUrl,
      members: formattedMembers,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      memberCount: room.members.length
    };

    res.json({
      statusCode: 200,
      data: formattedRoom
    });
  } catch (error) {
    console.error('Error getting room details:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลห้องแชท',
      error: error.message
    });
  }
});

// Update room details
router.put('/:roomId', upload.single('image'), async (req, res) => {
  console.log('=== Room Update Request ===');
  console.log('Room ID:', req.params.roomId);
  console.log('Update data:', req.body);
  console.log('File:', req.file);

  try {
    const { roomId } = req.params;
    let { name, description, color, imageUrl, members } = req.body;

    // Parse members if it's a JSON string
    if (typeof members === 'string') {
      try {
        members = JSON.parse(members);
      } catch (e) {
        console.error('Error parsing members JSON:', e);
        return res.status(400).json({
          statusCode: 400,
          message: 'รูปแบบข้อมูลสมาชิกไม่ถูกต้อง'
        });
      }
    }

    // Validate required fields
    if (!name) {
      console.log('[Validation Error] Room name is required');
      return res.status(400).json({
        statusCode: 400,
        message: 'ชื่อห้องเป็นข้อมูลที่จำเป็น'
      });
    }

    const room = await Room.findById(roomId);
    if (!room) {
      console.log('[Error] Room not found:', roomId);
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบห้องแชท'
      });
    }

    // Find current admin
    const currentAdmin = room.members.find(m => m.role === 'admin');
    if (!currentAdmin) {
      return res.status(400).json({
        statusCode: 400,
        message: 'ไม่พบผู้ดูแลห้องแชท'
      });
    }

    console.log('[Room Update] Current room data:', {
      name: room.name,
      admin: currentAdmin,
      memberCount: room.members.length,
      currentMembers: room.members
    });

    // Prepare update data
    const updateData = {
      name,
      description: description || room.description,
      color: color || room.color,
      updatedAt: new Date()
    };

    // Handle image upload if a new file was provided
    if (req.file) {
      // Delete old image if it exists
      if (room.imageUrl) {
        const fs = require('fs');
        const oldImagePath = path.join(__dirname, '..', '..', room.imageUrl);
        fs.unlink(oldImagePath, (err) => {
          if (err) console.error('Error deleting old image:', err);
        });
      }
      updateData.imageUrl = `/uploads/rooms/${req.file.filename}`;
    } else if (imageUrl) {
      updateData.imageUrl = imageUrl;
    }

    // Handle members update
    if (members && Array.isArray(members)) {
      console.log('[Room Update] Members update requested:', members);
      
      // Ensure current admin is in the members list with admin role
      const updatedMembers = members.map(member => {
        // Keep only necessary fields
        const { empId, role } = member;
        if (empId === currentAdmin.empId) {
          return { empId, role: 'admin' };
        }
        return { empId, role: role || 'User' };
      });

      // If current admin is not in the new members list, add them back
      if (!updatedMembers.some(m => m.empId === currentAdmin.empId)) {
        updatedMembers.push({
          empId: currentAdmin.empId,
          role: 'admin'
        });
      }

      // Remove duplicates and validate each member
      const uniqueMembers = updatedMembers.filter((member, index, self) => {
        // Check if member has required fields
        if (!member.empId || !member.role) {
          console.log('[Validation] Invalid member data:', member);
          return false;
        }
        // Keep only first occurrence of each empId
        return index === self.findIndex(m => m.empId === member.empId);
      });

      console.log('[Room Update] Processed members:', uniqueMembers);
      updateData.members = uniqueMembers;

      // Update unreadCounts for all members
      updateData.unreadCounts = uniqueMembers.map(member => ({
        user: member.empId,
        count: room.unreadCounts.find(uc => uc.user === member.empId)?.count || 0
      }));
    }

    console.log('[Room Update] Final update data:', {
      admin: currentAdmin.empId,
      memberCount: updateData.members?.length || room.members.length,
      members: updateData.members?.map(m => ({ empId: m.empId, role: m.role })) || room.members.map(m => ({ empId: m.empId, role: m.role }))
    });

    // Update room details
    const updatedRoom = await Room.findByIdAndUpdate(
      roomId,
      { $set: updateData },
      { new: true }
    );

    // Get member details using LDAP
    const memberPromises = updatedRoom.members.map(member => 
      findUserByEmployeeId(member.empId)
    );
    const memberResults = await Promise.all(memberPromises);
    
    const formattedMembers = memberResults.map((result, index) => {
      if (result.success && result.user) {
        return {
          employeeID: result.user.employeeID,
          fullName: result.user.fullName,
          department: result.user.department,
          profileImage: result.user.profileImage,
          role: updatedRoom.members[index].role,
          isAdmin: updatedRoom.members[index].role === 'admin'
        };
      }
      return null;
    }).filter(member => member !== null);

    // Format response
    const formattedRoom = {
      id: updatedRoom._id,
      name: updatedRoom.name,
      description: updatedRoom.description,
      color: updatedRoom.color,
      imageUrl: updatedRoom.imageUrl,
      members: formattedMembers,
      createdAt: updatedRoom.createdAt,
      updatedAt: updatedRoom.updatedAt,
      memberCount: updatedRoom.members.length
    };

    // Notify room members through socket about the update
    const io = req.app.get('io');
    if (io) {
      console.log('[Room Update] Emitting room update to members');
      io.to(roomId).emit('roomUpdated', {
        roomId,
        updatedRoom: formattedRoom,
        timestamp: new Date()
      });

      // Also update chat list for all members
      const updateChatList = req.app.get('updateChatList');
      if (updateChatList) {
        console.log('[Room Update] Updating chat list for all members');
        await updateChatList(roomId);
      }
    }

    res.json({
      statusCode: 200,
      message: 'อัพเดทข้อมูลห้องแชทสำเร็จ',
      data: formattedRoom
    });
  } catch (error) {
    // If there's an error and a file was uploaded, we should clean it up
    if (req.file) {
      const fs = require('fs');
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting uploaded file:', err);
      });
    }
    console.error('=== Room Update Error ===');
    console.error('Error details:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดทข้อมูลห้องแชท',
      error: error.message
    });
  }
});

// Delete room
router.delete('/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { employeeID } = req.body;

    // Verify user is admin or HR
    const user = await User.findOne({ employeeID });
    if (!user || !(user.role === 'admin' || user.role === 'Hr')) {
      return res.status(403).json({
        statusCode: 403,
        message: 'เฉพาะผู้ดูแลระบบและ HR เท่านั้นที่สามารถลบห้องแชทได้'
      });
    }

    // Find room and verify it exists
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        statusCode: 404,
        message: 'ไม่พบห้องแชท'
      });
    }

    // Delete all messages in the room
    await Message.deleteMany({ room: roomId });

    // Delete the room
    await room.deleteOne();

    // Notify all connected clients through socket
    const io = req.app.get('io');
    if (io) {
      io.emit('roomDeleted', {
        roomId,
        timestamp: new Date()
      });
    }

    res.json({
      statusCode: 200,
      message: 'ลบห้องแชทสำเร็จ',
      data: {
        deletedRoomId: roomId,
        deletedAt: formatThaiDateTime(new Date())
      }
    });
  } catch (error) {
    console.error('Error deleting room:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการลบห้องแชท',
      error: error.message
    });
  }
});

module.exports = router; 
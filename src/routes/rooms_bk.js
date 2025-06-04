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

    // Initialize unreadCounts for all members including admin
    const allMembers = [
      { empId: admin.empId, role: admin.role },
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
      admin,
      members,
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
    if (room.admin.empId === userId) {
      return res.status(400).json({
        statusCode: 400,
        message: 'ไม่สามารถลบ admin ออกจากห้องได้'
      });
    }

    // Check if user is a member
    const isMember = room.members.some(member => member.empId === userId);
    if (!isMember) {
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

    // Get rooms where empId is a member or admin
    const rooms = await Room.find({
      $or: [
        { 'members.empId': empId },
        { 'admin.empId': empId }
      ]
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
        imageUrl:  room.imageUrl,
        color: room.color,
        admin: room.admin ? room.admin.empId : null,
        adminRole: room.admin ? room.admin.role : null,
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
      'admin': 1,
      'isActive': 1,
      'createdAt': 1,
      'updatedAt': 1
    });

    // Get admin details from LDAP
    const adminPromises = rooms.map(room => findUserByEmployeeId(room.admin.empId));
    const adminResults = await Promise.all(adminPromises);
    
    const adminMap = adminResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
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
      const admin = adminMap[room.admin.empId];
      
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

      // Calculate total members (admin + all members)
      const totalMembers = room.members.length + 1; // +1 for admin

      return {
        ...room.toObject(),
        admin: admin ? {
          employeeID: admin.employeeID,
          fullName: admin.fullName,
          department: admin.department,
          role: room.admin.role
        } : room.admin,
        members: formattedMembers,
        totalMembers: totalMembers,
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

    // Get all member IDs (including admin) using Set to prevent duplicates
    const memberIds = [...new Set([
      ...room.members.map(m => m.empId),
      room.admin.empId
    ])];

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
    const formattedMembers = memberIds.map(empId => {
      const user = userMap[empId];
      const isAdmin = room.admin.empId === empId;
      const memberRole = room.members.find(m => m.empId === empId)?.role;
      const isBot = memberRole === 'bot';
      const botDetails = isBot ? botMap[empId] : null;

      return {
        employeeID: empId,
        fullName: isBot ? (botDetails?.name || 'Unknown Bot') : (user?.fullName || 'Unknown User'),
        department: isBot ? 'bot notify' : (user?.department || 'Unknown Department'),
        profileImage: user?.profileImage || null,
        role: isAdmin ? room.admin.role : memberRole,
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

    // Get all member IDs (including admin) using Set to prevent duplicates
    const memberIds = [...new Set([
      ...room.members.map(m => m.empId),
      room.admin.empId
    ])];

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
    const formattedMembers = memberIds.map(empId => {
      const user = userMap[empId];
      const isAdmin = room.admin.empId === empId;
      const memberRole = room.members.find(m => m.empId === empId)?.role;
      const isBot = memberRole === 'bot';
      const botDetails = isBot ? botMap[empId] : null;

      return {
        employeeID: empId,
        fullName: isBot ? (botDetails?.name || 'Unknown Bot') : (user?.fullName || 'Unknown User'),
        department: isBot ? 'bot notify' : (user?.department || 'Unknown Department'),
        profileImage: `http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/${empId}.jpg` || null,
        role: isAdmin ? room.admin.role : memberRole,
        isAdmin: isAdmin
      };
    });

    // Get admin details using LDAP
    const adminResult = await findUserByEmployeeId(room.admin.empId);
    const adminDetails = adminResult.success ? adminResult.user : null;

    // Format response
    const formattedRoom = {
      id: room._id,
      name: room.name,
      description: room.description,
      color: room.color,
      imageUrl: room.imageUrl,
      admin: adminDetails ? {
        employeeID: adminDetails.employeeID,
        fullName: adminDetails.fullName,
        department: adminDetails.department,
        profileImage: adminDetails.profileImage,
        role: room.admin.role
      } : null,
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
    const { name, description, color, imageUrl, admin, members } = req.body;

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

    console.log('[Room Update] Current room data:', {
      name: room.name,
      admin: room.admin,
      memberCount: room.members.length
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
      // If imageUrl was provided in the request but no file was uploaded
      updateData.imageUrl = imageUrl;
    }

    // Handle admin update if provided
    if (admin) {
      console.log('[Room Update] Updating admin:', admin);
      
      // Get current admin info
      const currentAdmin = room.admin;
      
      // Create new members array without the new admin (if they were a member)
      let updatedMembers = room.members.filter(member => member.empId !== admin.empId);
      
      // Add previous admin to members list with member role
      updatedMembers.push({
        empId: currentAdmin.empId,
        role: 'User'  // Set role to member for previous admin
      });
      
      // Update both admin and members
      updateData.admin = {
        empId: admin.empId,
        role: admin.role || 'admin'
      };
      updateData.members = updatedMembers;
      
      console.log('[Room Update] Swapped admin positions:', {
        newAdmin: admin.empId,
        previousAdmin: currentAdmin.empId,
        previousAdminNewRole: 'User',
        totalMembers: updatedMembers.length,
        membersList: updatedMembers.map(m => ({ empId: m.empId, role: m.role }))
      });
    }

    // Handle members update if provided
    if (members && Array.isArray(members)) {
      console.log('[Room Update] Updating members:', members);
      
      // Check if current admin is in the new members list
      const currentAdminInNewMembers = members.some(member => member.empId === room.admin.empId);
      
      // If current admin is in new members list, update their role to 'member'
      if (currentAdminInNewMembers) {
        console.log('[Room Update] Moving current admin to members with member role:', room.admin.empId);
        const updatedMembers = members.map(member => {
          if (member.empId === room.admin.empId) {
            return {
              empId: member.empId,
              role: 'User'  // Set role to member for previous admin
            };
          }
          return {
            empId: member.empId,
            role: member.role || 'User'
          };
        });
        updateData.members = updatedMembers;
      } else {
        updateData.members = members.map(member => ({
          empId: member.empId,
          role: member.role || 'User'
        }));
      }
    }

    // Update room details
    const updatedRoom = await Room.findByIdAndUpdate(
      roomId,
      { $set: updateData },
      { new: true }
    );

    console.log('[Room Update] Room updated successfully:', {
      id: updatedRoom._id,
      name: updatedRoom.name,
      admin: updatedRoom.admin,
      memberCount: updatedRoom.members.length
    });

    // Get admin details using LDAP
    const adminResult = await findUserByEmployeeId(updatedRoom.admin.empId);
    const adminDetails = adminResult.success ? adminResult.user : null;

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
          role: updatedRoom.members[index].role
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
      admin: adminDetails ? {
        employeeID: adminDetails.employeeID,
        fullName: adminDetails.fullName,
        department: adminDetails.department,
        profileImage: adminDetails.profileImage,
        role: updatedRoom.admin.role
      } : null,
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
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
//require('dotenv').config();
require('dotenv').config({ path: '/var/www/12NotifyAPI/.env' });
const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: ["*"],
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
    transports: ['websocket']
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
  connectTimeout: 45000,
  path: '/socket.io/',
  allowUpgrades: true,
  cookie: {
    name: 'io',
    path: '/',
    httpOnly: true,
    sameSite: 'lax'
  }
});

// Store connected users
const connectedUsers = new Map();

// Make io instance available to routes
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve static files for announcements
app.use('/uploads/announcements', express.static(path.join(__dirname, '../uploads/announcements')));
// Serve static files for chat room images
app.use('/uploads/rooms', express.static(path.join(__dirname, '../uploads/rooms')));

app.use('/uploads/directMessage', express.static(path.join(__dirname, '../uploads/directMessage')));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://192.168.2.96/notification-system', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// Socket.IO Connection
io.on('connection', (socket) => {
  console.log('=== New Socket Connection ===');
  console.log('Socket ID:', socket.id);
  console.log('Auth Data:', socket.handshake.auth);
  console.log('Query Data:', socket.handshake.query);
  
  const userId = socket.handshake.auth.userId || socket.handshake.query.userId;
  
  if (userId) {
    connectedUsers.set(userId, socket.id);
    console.log(`[User Connection] User ${userId} connected with socket ${socket.id}`);
    console.log('Current connected users:', Array.from(connectedUsers.entries()));
  } else {
    console.log('[Warning] Connection attempt without userId');
  }

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('=== Socket Connection Error ===');
    console.error('Socket ID:', socket.id);
    console.error('Error details:', error);
    socket.emit('error', { message: 'Connection error', error: error.message });
  });

  // Handle user connection
  socket.on('userConnected', async (data) => {
    console.log('=== User Connected Event ===');
    console.log('Socket ID:', socket.id);
    console.log('Connection data:', data);
    
    try {
      const { userId } = data;
      if (userId) {
        connectedUsers.set(userId, socket.id);
        console.log(`[User Connected] User ${userId} connected with socket ${socket.id}`);
        console.log('Updated connected users:', Array.from(connectedUsers.entries()));
        
        // Get user's rooms and join them
        const Room = require('./models/Room');
        const rooms = await Room.find({
          $or: [
            { 'members.empId': userId },
            { 'admin.empId': userId }
          ]
        });
        
        console.log(`[Room Auto-Join] Found ${rooms.length} rooms for user ${userId}`);
        rooms.forEach(room => {
          socket.join(room._id.toString());
          console.log(`[Room Auto-Join] User ${userId} joined room: ${room._id}`);
        });
      }
    } catch (error) {
      console.error('=== User Connection Error ===');
      console.error('Socket ID:', socket.id);
      console.error('Error details:', error);
      socket.emit('error', { message: 'Error handling connection', error: error.message });
    }
  });

  // Join chat room
  socket.on('joinRoom', async (data) => {
    try {
      const { roomId, userId } = data;
      if (!roomId) throw new Error('Room ID is required');

      // Verify user has access to room
      const Room = require('./models/Room');
      const room = await Room.findOne({
        _id: roomId,
        $or: [
          { 'members.empId': userId },
          { 'admin.empId': userId }
        ]
      });

      if (!room) {
        throw new Error('Room not found or access denied');
      }

      socket.join(roomId);
      console.log(`User ${userId} joined room: ${roomId}`);
      
      // Acknowledge successful join
      socket.emit('roomJoined', { 
        roomId, 
        success: true,
        room: {
          id: room._id,
          name: room.name,
          description: room.description,
          color: room.color,
          members: room.members,
          admin: room.members.find(member => member.role === 'admin')
        }
      });

      // Notify others in room
      socket.to(roomId).emit('userJoined', {
        roomId,
        userId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('roomJoined', { 
        roomId: data.roomId, 
        success: false, 
        error: error.message 
      });
    }
  });

  // Leave chat room
  socket.on('leaveRoom', async (data) => {
    try {
      const { roomId, userId } = data;
      if (!roomId) throw new Error('Room ID is required');

      socket.leave(roomId);
      console.log(`User ${userId} left room: ${roomId}`);
      
      // Acknowledge successful leave
      socket.emit('roomLeft', { roomId, success: true });

      // Notify others in room
      socket.to(roomId).emit('userLeft', {
        roomId,
        userId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error leaving room:', error);
      socket.emit('roomLeft', { 
        roomId: data.roomId, 
        success: false, 
        error: error.message 
      });
    }
  });

  // Handle messages
  socket.on('sendMessage', async (data) => {
    console.log('=== New Message Event ===');
    console.log('Socket ID:', socket.id);
    console.log('Message data:', JSON.stringify(data, null, 2));
    
    try {
      // Validate required fields
      if (!data.roomId || !data.employeeId) {
        console.error('[Message Error] Missing required fields');
        console.error('Received data:', data);
        throw new Error('Missing required fields');
      }

      // Check if message is an image
      const isImage = data.isImage || false;
      const imageUrl = data.imageUrl || null;
      
      console.log('[Message Type]', {
        isImage,
        imageUrl,
        messageType: typeof data.message,
        isArray: Array.isArray(data.message)
      });
      
      // Convert message to string if it's an array and not an image
      const messageText = !isImage && Array.isArray(data.message) ? data.message.join('\n') : data.message;

      // Get user details from LDAP
      const { findUserByEmployeeId } = require('./services/ldapServices');
      const userDetails = await findUserByEmployeeId(data.employeeId);
      console.log('[User Details]', userDetails);
      
      if (!userDetails.success || !userDetails.user) {
        console.error('[Message Error] User not found:', data.employeeId);
        throw new Error('User not found');
      }

      const user = userDetails.user;
      const roomIds = Array.isArray(data.roomId) ? data.roomId : [data.roomId];
      console.log('[Message Rooms] Sending to rooms:', roomIds);
      
      // Save message to database
      const Message = require('./models/Message');
      const Room = require('./models/Room');
      
      for (const roomId of roomIds) {
        console.log(`[Message Processing] Processing room: ${roomId}`);
        
        // Create message record
        const message = new Message({
          room: roomId,
          sender: data.employeeId,
          isRead: false,
          createdAt: new Date(),
          isImage: isImage,
          ...(isImage ? { imageUrl: imageUrl } : {}),
          ...(messageText ? { message: messageText } : {})
        });

        await message.save();
        console.log(`[Message Saved] Message saved with ID: ${message._id}`);

        // Update room's lastMessage
        const roomUpdate = await Room.findByIdAndUpdate(roomId, {
          $set: {
            lastMessage: {
              sender: data.employeeId,
              timestamp: message.createdAt,
              isoString: message.createdAt.toISOString(),
              isImage: isImage,
              ...(isImage ? { imageUrl: imageUrl } : {}),
              ...(messageText ? { message: messageText } : {})
            }
          },
          $inc: {
            'unreadCounts.$[elem].count': 1
          }
        }, {
          arrayFilters: [{ 'elem.user': { $ne: data.employeeId } }]
        });
        console.log(`[Room Updated] Room ${roomId} updated with new message`);

        // Broadcast to room
        const messageToEmit = {
          _id: message._id,
          room: roomId,
          sender: {
            employeeID: user.employeeID,
            fullName: user.fullName,
            department: user.department,
            imgUrl: user.imgUrl || null
          },
          timestamp: message.createdAt,
          isRead: false,
          isImage: isImage,
          ...(isImage ? { imageUrl: imageUrl } : {}),
          ...(messageText ? { message: messageText } : {})
        };

        console.log('[Message Broadcast] Emitting to room:', JSON.stringify(messageToEmit, null, 2));
        io.to(roomId).emit('newMessage', messageToEmit);
      }

      // Acknowledge successful message send
      socket.emit('messageSent', { 
        success: true,
        message: 'Message sent successfully',
        data: {
          roomIds,
          sender: {
            employeeID: user.employeeID,
            fullName: user.fullName,
            department: user.department,
            imgUrl: user.imgUrl || null
          },
          timestamp: new Date(),
          isImage: isImage,
          ...(isImage ? { imageUrl: imageUrl } : {}),
          ...(messageText ? { message: messageText } : {})
        }
      });
      console.log('[Message Complete] Message successfully sent and acknowledged');
      
    } catch (error) {
      console.error('=== Message Error ===');
      console.error('Socket ID:', socket.id);
      console.error('Error details:', error);
      console.error('Failed message data:', data);
      socket.emit('messageSent', { 
        success: false, 
        error: error.message,
        message: 'Failed to send message'
      });
    }
  });

  // Handle typing status
  socket.on('typing', (data) => {
    const { roomId, userId, isTyping } = data;
    if (roomId && userId) {
      socket.to(roomId).emit('userTyping', {
        roomId,
        userId,
        isTyping,
        timestamp: new Date()
      });
    }
  });

  // Handle read receipts
  socket.on('markAsRead', async (data) => {
    try {
      const { roomId, userId } = data;
      if (!roomId || !userId) throw new Error('Room ID and User ID are required');

      const Message = require('./models/Message');
      const Room = require('./models/Room');

      // Update message read status
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

      // Reset unread count for user
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

      // Notify others in room
      socket.to(roomId).emit('messagesRead', {
        roomId,
        userId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error marking messages as read:', error);
      socket.emit('error', { 
        message: 'Failed to mark messages as read',
        error: error.message
      });
    }
  });

  // Handle chat list updates
  socket.on('subscribeChatList', async (data) => {
    try {
      const { empId } = data;
      if (!empId) throw new Error('Employee ID is required');

      // Join user's chat list room
      const chatListRoom = `chatList:${empId}`;
      socket.join(chatListRoom);
      console.log(`User ${empId} subscribed to chat list updates`);

      // Get initial chat list
      const Room = require('./models/Room');
      const Message = require('./models/Message');
      const { findUserByEmployeeId } = require('./services/ldapServices');
      const Bot = require('./models/Bot');

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
      
      // Get user details for all senders
      const userPromises = senderIds.map(id => findUserByEmployeeId(id));
      const userResults = await Promise.all(userPromises);
      
      const userMap = userResults.reduce((map, result) => {
        if (result.success && result.user) {
          map[result.user.employeeID] = result.user;
        }
        return map;
      }, {});

      // Get bot details
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

        const userRole = room.members.find(
          member => member.empId === empId
        )?.role || null;

        const lastMessageSender = lastMessage?.sender ? 
          (userMap[lastMessage.sender] || botMap[lastMessage.sender]) : null;

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
          isoString: lastMessage.createdAt.toISOString()
        } : null;

        return {
          id: room._id,
          name: room.name,
          description: room.description,
          imageUrl: room.imageUrl,
          color: room.color,
          admin: (() => {
            const adminMember = room.members.find(member => member.role === 'admin');
            return adminMember ? adminMember.empId : null;
          })(),
          adminRole: (() => {
            const adminMember = room.members.find(member => member.role === 'admin');
            return adminMember ? adminMember.role : null;
          })(),
          userRole,
          lastMessage: formattedLastMessage,
          unreadCount,
          memberCount: room.members.length
        };
      });

      // คำนวณจำนวนข้อความที่ยังไม่ได้อ่านทั้งหมด
      const totalUnreadCount = formattedRooms.reduce((total, room) => total + (room.unreadCount || 0), 0);

      // Send initial chat list
      socket.emit('chatListUpdate', {
        rooms: formattedRooms,
        totalUnreadCount: totalUnreadCount,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Error subscribing to chat list:', error);
      socket.emit('error', { 
        message: 'Failed to subscribe to chat list',
        error: error.message
      });
    }
  });

  // Handle unsubscribing from chat list
  socket.on('unsubscribeChatList', (data) => {
    const { empId } = data;
    if (empId) {
      const chatListRoom = `chatList:${empId}`;
      socket.leave(chatListRoom);
      console.log(`User ${empId} unsubscribed from chat list updates`);
    }
  });

  // ========== DIRECT MESSAGE HANDLERS ==========
  
  // Join Direct Message room
  socket.on('joinDirectMessageRoom', async (data) => {
    try {
      const { employeeId, recipientId } = data;
      if (!employeeId || !recipientId) {
        throw new Error('Employee ID and Recipient ID are required');
      }

      // สร้าง room ID สำหรับ direct message
      const [id1, id2] = [employeeId, recipientId].sort();
      const directMessageRoomId = `dm-${id1}-${id2}`;

      socket.join(directMessageRoomId);
      console.log(`User ${employeeId} joined DirectMessage room: ${directMessageRoomId}`);
      
      // Acknowledge successful join
      socket.emit('directMessageRoomJoined', { 
        roomId: directMessageRoomId, 
        success: true,
        participants: [employeeId, recipientId]
      });

      // Notify other participant
      socket.to(directMessageRoomId).emit('userJoinedDirectMessage', {
        roomId: directMessageRoomId,
        userId: employeeId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error joining DirectMessage room:', error);
      socket.emit('directMessageRoomJoined', { 
        success: false, 
        error: error.message 
      });
    }
  });

  // Mark Direct Messages as Read
  socket.on('markDirectMessagesRead', async (data) => {
    try {
      const { messageIds, employeeId } = data;
      if (!Array.isArray(messageIds) || messageIds.length === 0 || !employeeId) {
        throw new Error('Message IDs and Employee ID are required');
      }

      const DirectMessage = require('./models/DirectMessage');
      const { findUserByEmployeeId } = require('./services/ldapServices');

      // Update messages as read
      const result = await DirectMessage.updateMany(
        {
          _id: { $in: messageIds },
          participants: employeeId,
          sender: { $ne: employeeId },
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

      if (result.modifiedCount > 0) {
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

        // Send WebSocket notifications to senders
        for (const senderId of senderIds) {
          if (senderId !== employeeId) {
            const readerDetails = await findUserByEmployeeId(employeeId);
            if (readerDetails.success && readerDetails.user) {
              // สร้าง room ID สำหรับ direct message
              const [id1, id2] = [employeeId, senderId].sort();
              const directMessageRoomId = `dm-${id1}-${id2}`;
              
              io.to(directMessageRoomId).emit('directMessagesRead', {
                messageIds,
                readBy: {
                  employeeID: readerDetails.user.employeeID,
                  fullName: readerDetails.user.fullNameThai,
                  department: readerDetails.user.department,
                  imgUrl: readerDetails.user.imgUrl || null
                },
                timestamp: new Date(),
                isoString: new Date().toISOString()
              });
            }
          }
        }

        // Acknowledge successful mark as read
        socket.emit('directMessagesMarkedAsRead', {
          success: true,
          messageIds,
          modifiedCount: result.modifiedCount
        });
      } else {
        socket.emit('directMessagesMarkedAsRead', {
          success: false,
          message: 'No messages were marked as read'
        });
      }
    } catch (error) {
      console.error('Error marking direct messages as read:', error);
      socket.emit('directMessagesMarkedAsRead', { 
        success: false, 
        error: error.message 
      });
    }
  });

  // Leave Direct Message room
  socket.on('leaveDirectMessageRoom', async (data) => {
    try {
      const { employeeId, recipientId } = data;
      if (!employeeId || !recipientId) {
        throw new Error('Employee ID and Recipient ID are required');
      }

      // สร้าง room ID สำหรับ direct message
      const [id1, id2] = [employeeId, recipientId].sort();
      const directMessageRoomId = `dm-${id1}-${id2}`;

      socket.leave(directMessageRoomId);
      console.log(`User ${employeeId} left DirectMessage room: ${directMessageRoomId}`);
      
      // Acknowledge successful leave
      socket.emit('directMessageRoomLeft', { 
        roomId: directMessageRoomId, 
        success: true 
      });

      // Notify other participant
      socket.to(directMessageRoomId).emit('userLeftDirectMessage', {
        roomId: directMessageRoomId,
        userId: employeeId,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error leaving DirectMessage room:', error);
      socket.emit('directMessageRoomLeft', { 
        success: false, 
        error: error.message 
      });
    }
  });

  // Subscribe to Direct Message chat list
  socket.on('subscribeDirectMessageList', async (data) => {
    try {
      const { empId } = data;
      if (!empId) throw new Error('Employee ID is required');

      // Join user's DM chat list room
      const dmChatListRoom = `dmChatList:${empId}`;
      socket.join(dmChatListRoom);
      console.log(`User ${empId} subscribed to DirectMessage chat list updates`);

      // Get initial DM chat list
      const DirectMessage = require('./models/DirectMessage');
      const { findUserByEmployeeId } = require('./services/ldapServices');

      // Get conversations where empId is a participant
      const conversations = await DirectMessage.aggregate([
        {
          $match: {
            participants: empId
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
                cond: { $ne: ['$$participant', empId] }
              }
            },
            lastMessage: { $first: '$$ROOT' },
            unreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$sender', empId] },
                      { $eq: ['$isRead', false] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        },
        {
          $project: {
            participantId: { $arrayElemAt: ['$_id', 0] },
            lastMessage: 1,
            unreadCount: 1,
            _id: 0
          }
        }
      ]);

      // Get user details for all participants
      const participantIds = conversations.map(conv => conv.participantId);
      const userPromises = participantIds.map(id => findUserByEmployeeId(id));
      const userResults = await Promise.all(userPromises);
      
      const userMap = userResults.reduce((map, result) => {
        if (result.success && result.user) {
          map[result.user.employeeID] = result.user;
        }
        return map;
      }, {});

      // Format conversations
      const formattedConversations = conversations.map(conv => {
        const participant = userMap[conv.participantId];
        const lastMessage = conv.lastMessage;
        
        return {
          participantId: conv.participantId,
          participant: participant ? {
            employeeID: participant.employeeID,
            fullName: participant.fullNameThai,
            department: participant.department,
            imgUrl: participant.imgUrl || null
          } : null,
          lastMessage: {
            _id: lastMessage._id,
            message: lastMessage.message || '',
            isImage: lastMessage.isImage || false,
            imageUrl: lastMessage.imageUrl || null,
            isFile: lastMessage.isFile || false,
            fileUrl: lastMessage.fileUrl || null,
            fileName: lastMessage.fileName || null,
            fileType: lastMessage.fileType || null,
            isRead: lastMessage.isRead || false,
            sender: lastMessage.sender,
            createdAt: lastMessage.createdAt,
            isoString: lastMessage.createdAt.toISOString()
          },
          unreadCount: conv.unreadCount || 0
        };
      });

      // คำนวณจำนวนแชทที่ยังไม่ได้อ่านทั้งหมด
      const totalUnreadCount = formattedConversations.reduce((total, conv) => total + (conv.unreadCount || 0), 0);

      // Send initial DM chat list
      socket.emit('directMessageListUpdate', {
        conversations: formattedConversations,
        totalUnreadCount: totalUnreadCount,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Error subscribing to DirectMessage chat list:', error);
      socket.emit('error', { 
        message: 'Failed to subscribe to DirectMessage chat list',
        error: error.message
      });
    }
  });

  // Unsubscribe from Direct Message chat list
  socket.on('unsubscribeDirectMessageList', (data) => {
    const { empId } = data;
    if (empId) {
      const dmChatListRoom = `dmChatList:${empId}`;
      socket.leave(dmChatListRoom);
      console.log(`User ${empId} unsubscribed from DirectMessage chat list updates`);
    }
  });

 
  // Function to update Direct Message chat list
  const updateDirectMessageChatList = async (employeeId, recipientId) => {
    console.log('=== Direct Message Chat List Update ===');
    console.log('Updating DM chat list for:', { employeeId, recipientId });
    
    try {
      const DirectMessage = require('./models/DirectMessage');
      const { findUserByEmployeeId } = require('./services/ldapServices');

      // Get last message between these two users
      const lastMessage = await DirectMessage.findOne({
        participants: { $all: [employeeId, recipientId] }
      }).sort({ createdAt: -1 });

      if (!lastMessage) {
        console.log('[DM Chat List] No messages found between users');
        return;
      }

      // Get unread count for this conversation
      const unreadCount = await DirectMessage.countDocuments({
        participants: { $all: [employeeId, recipientId] },
        sender: { $ne: employeeId },
        isRead: false
      });

      // Get participant details
      const participantDetails = await findUserByEmployeeId(recipientId);
      const senderDetails = await findUserByEmployeeId(lastMessage.sender);

      if (!participantDetails.success || !participantDetails.user) {
        console.log('[DM Chat List] Participant not found:', recipientId);
        return;
      }

      const formattedConversation = {
        participantId: recipientId,
        participant: {
          employeeID: participantDetails.user.employeeID,
          fullName: participantDetails.user.fullNameThai,
          department: participantDetails.user.department,
          imgUrl: participantDetails.user.imgUrl || null
        },
        lastMessage: {
          _id: lastMessage._id,
          message: lastMessage.message || '',
          isImage: lastMessage.isImage || false,
          imageUrl: lastMessage.imageUrl || null,
          isFile: lastMessage.isFile || false,
          fileUrl: lastMessage.fileUrl || null,
          fileName: lastMessage.fileName || null,
          fileType: lastMessage.fileType || null,
          isRead: lastMessage.isRead || false,
          sender: lastMessage.sender,
          createdAt: lastMessage.createdAt,
          isoString: lastMessage.createdAt.toISOString()
        },
        unreadCount: unreadCount
      };

      // Emit update to both participants' DM chat list rooms
      io.to(`dmChatList:${employeeId}`).emit('directMessageListUpdate', {
        conversations: [formattedConversation],
        timestamp: new Date()
      });
      
      io.to(`dmChatList:${recipientId}`).emit('directMessageListUpdate', {
        conversations: [formattedConversation],
        timestamp: new Date()
      });

      console.log('[DM Chat List] Update complete for users:', { employeeId, recipientId });
    } catch (error) {
      console.error('=== Direct Message Chat List Update Error ===');
      console.error('Users:', { employeeId, recipientId });
      console.error('Error details:', error);
    }
  };

  // Make updateDirectMessageChatList available to routes
  app.set('updateDirectMessageChatList', updateDirectMessageChatList);

  // Function to update chat list for all room members
  const updateChatList = async (roomId) => {
    console.log('=== Chat List Update ===');
    console.log('Updating chat list for room:', roomId);
    
    try {
      const Room = require('./models/Room');
      const Message = require('./models/Message');
      const User = require('./models/User');
      const { findUserByEmployeeId } = require('./services/ldapServices');
      const Bot = require('./models/Bot');

      const room = await Room.findById(roomId);
      if (!room) {
        console.log('[Chat List] Room not found:', roomId);
        return;
      }

      // Get all room members
      const memberIds = room.members.map(member => member.empId);
      console.log('[Chat List] Room members:', memberIds);

      // Get last message
      const lastMessage = await Message.findOne({ room: roomId })
        .sort({ createdAt: -1 })
        .limit(1);

      if (!lastMessage) {
        console.log('[Chat List] No messages found for room:', roomId);
        return;
      }
      console.log('[Chat List] Last message:', lastMessage);

      // Get sender details
      let sender;
      if (lastMessage.sender) {
        console.log('[Chat List] Processing sender:', lastMessage.sender);
        const botUser = await User.findOne({ employeeID: lastMessage.sender, role: 'bot' });
        if (botUser) {
          const bot = await Bot.findOne({ employeeID: lastMessage.sender });
          if (bot) {
            sender = {
              employeeID: bot.employeeID,
              fullName: bot.name,
              department: 'bot notify',
              profileImage: null,
              role: 'bot'
            };
            console.log('[Chat List] Sender is bot:', sender);
          }
        } else {
          const userDetails = await findUserByEmployeeId(lastMessage.sender);
          if (userDetails.success && userDetails.user) {
            sender = {
              employeeID: userDetails.user.employeeID,
              fullName: userDetails.user.fullName,
              department: userDetails.user.department,
              profileImage: userDetails.user.profileImage || null,
              role: 'user'
            };
            console.log('[Chat List] Sender is user:', sender);
          }
        }
      }

      // Format last message
      const formattedLastMessage = {
        message: lastMessage.message || '',
        sender: sender,
        timestamp: lastMessage.createdAt,
        isoString: lastMessage.createdAt.toISOString()
      };
      console.log('[Chat List] Formatted last message:', formattedLastMessage);

      // Update chat list for each member
      for (const memberId of memberIds) {
        console.log(`[Chat List] Updating for member: ${memberId}`);
        const unreadCount = room.unreadCounts.find(
          count => count.user === memberId
        )?.count || 0;

        const userRole = room.members.find(
          member => member.empId === memberId
        )?.role || null;

        const formattedRoom = {
          id: room._id,
          name: room.name,
          description: room.description,
          color: room.color,
          admin: (() => {
            const adminMember = room.members.find(member => member.role === 'admin');
            return adminMember ? adminMember.empId : null;
          })(),
          adminRole: (() => {
            const adminMember = room.members.find(member => member.role === 'admin');
            return adminMember ? adminMember.role : null;
          })(),
          userRole,
          lastMessage: formattedLastMessage,
          unreadCount,
          memberCount: room.members.length
        };

        // Emit update to member's chat list room
        io.to(`chatList:${memberId}`).emit('chatListUpdate', {
          rooms: [formattedRoom],
          timestamp: new Date()
        });
        console.log(`[Chat List] Update emitted to member: ${memberId}`);
      }
      console.log('[Chat List] Update complete for room:', roomId);
    } catch (error) {
      console.error('=== Chat List Update Error ===');
      console.error('Room ID:', roomId);
      console.error('Error details:', error);
    }
  };

  // Make updateChatList available to routes
  app.set('updateChatList', updateChatList);

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('=== Socket Disconnection ===');
    console.log('Socket ID:', socket.id);
    console.log('Disconnect reason:', reason);
    
    // Remove user from connected users
    for (const [userId, socketId] of connectedUsers.entries()) {
      if (socketId === socket.id) {
        connectedUsers.delete(userId);
        console.log(`[User Disconnection] User ${userId} disconnected`);
        console.log('Remaining connected users:', Array.from(connectedUsers.entries()));
        break;
      }
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('=== Socket Error ===');
    console.error('Socket ID:', socket.id);
    console.error('Error details:', error);
    socket.emit('error', { message: 'An error occurred', error: error.message });
  });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/users', require('./routes/users'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/direct-messages', require('./routes/directMessageRoutes'));

const PORT = process.env.PORT || 8006;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

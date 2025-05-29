const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
    transports: ['websocket', 'polling']
  },
  allowEIO3: true, // Allow Engine.IO v3 clients
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8, // Increase buffer size for larger messages
  connectTimeout: 45000, // Increase connection timeout
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

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/notification-system', {
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
          admin: room.admin
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
          admin: room.admin ? room.admin.empId : null,
          adminRole: room.admin ? room.admin.role : null,
          userRole,
          lastMessage: formattedLastMessage,
          unreadCount,
          memberCount: room.members.length
        };
      });

      // Send initial chat list
      socket.emit('chatListUpdate', {
        rooms: formattedRooms,
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
      if (room.admin?.empId) {
        memberIds.push(room.admin.empId);
      }
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
          admin: room.admin ? room.admin.empId : null,
          adminRole: room.admin ? room.admin.role : null,
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
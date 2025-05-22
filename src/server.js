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
  console.log('New client connected:', socket.id);
  const userId = socket.handshake.auth.userId || socket.handshake.query.userId;
  
  if (userId) {
    connectedUsers.set(userId, socket.id);
    console.log(`User ${userId} connected with socket ${socket.id}`);
  }

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('Connection error:', error);
    socket.emit('error', { message: 'Connection error', error: error.message });
  });

  // Handle user connection
  socket.on('userConnected', async (data) => {
    try {
      const { userId } = data;
      if (userId) {
        connectedUsers.set(userId, socket.id);
        console.log(`User ${userId} connected with socket ${socket.id}`);
        
        // Get user's rooms and join them
        const Room = require('./models/Room');
        const rooms = await Room.find({
          $or: [
            { 'members.empId': userId },
            { 'admin.empId': userId }
          ]
        });
        
        rooms.forEach(room => {
          socket.join(room._id.toString());
          console.log(`User ${userId} auto-joined room: ${room._id}`);
        });
      }
    } catch (error) {
      console.error('Error handling user connection:', error);
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
    try {
      console.log('Received message via socket:', JSON.stringify(data, null, 2));
      
      // Validate required fields
      if (!data.roomId || !data.employeeId) {
        throw new Error('Missing required fields');
      }

      // Check if message is an image
      const isImage = data.isImage || false;
      const imageUrl = data.imageUrl || null;
      
      console.log('Message type check:', {
        originalIsImage: data.isImage,
        originalImageUrl: data.imageUrl,
        processedIsImage: isImage,
        processedImageUrl: imageUrl,
        messageType: typeof data.message,
        isArray: Array.isArray(data.message)
      });
      
      // Convert message to string if it's an array and not an image
      const messageText = !isImage && Array.isArray(data.message) ? data.message.join('\n') : data.message;

      // Get user details from LDAP
      const { findUserByEmployeeId } = require('./services/ldapServices');
      const userDetails = await findUserByEmployeeId(data.employeeId);
      if (!userDetails.success || !userDetails.user) {
        throw new Error('User not found');
      }

      const user = userDetails.user;
      const roomIds = Array.isArray(data.roomId) ? data.roomId : [data.roomId];
      
      // Save message to database
      const Message = require('./models/Message');
      const Room = require('./models/Room');
      
      for (const roomId of roomIds) {
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

        // Update room's lastMessage
        await Room.findByIdAndUpdate(roomId, {
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

        console.log('Emitting message to room:', JSON.stringify(messageToEmit, null, 2));
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
    } catch (error) {
      console.error('Error sending message via socket:', error);
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

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    
    // Remove user from connected users
    for (const [userId, socketId] of connectedUsers.entries()) {
      if (socketId === socket.id) {
        connectedUsers.delete(userId);
        console.log(`User ${userId} disconnected`);
        break;
      }
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
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
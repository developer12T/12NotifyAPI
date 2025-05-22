const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  room: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true,
    index: true
  },
  sender: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: function() {
      return !this.isImage; // Required only if not an image message
    },
    trim: true
  }, 
  isRead: {
    type: Boolean,
    default: false
  },
  readBy: [{
    user: String,
    readAt: Date
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  isImage: {
    type: Boolean,
    default: false
  },
  imageUrl: {
    type: String,
    required: function() {
      return this.isImage; // Required only if it's an image message
    },
    default: null
  },
  isAdminNotification: {
    type: Boolean,
    default: false
  }
});

// Indexes for better query performance
messageSchema.index({ room: 1, createdAt: -1 });
messageSchema.index({ sender: 1 });
messageSchema.index({ isRead: 1 });
messageSchema.index({ isImage: 1 });
messageSchema.index({ isAdminNotification: 1 });

module.exports = mongoose.model('Message', messageSchema); 
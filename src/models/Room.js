const mongoose = require('mongoose');
const { getThaiTime, getThaiTimeISOString } = require('../utils/timeUtils');

const roomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  color: {
    type: String,
    default: '#007bff', // Default blue color
    trim: true
  },
  members: [{
    empId: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['admin', 'User', 'bot', 'owner'],
      default: 'User'
    }
  }],
  lastMessage: {
    message: String,
    sender: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    isoString: {
      type: String,
      default: function() {
        return getThaiTimeISOString(this.timestamp);
      }
    }
  },
  unreadCounts: [{
    user: String,
    count: {
      type: Number,
      default: 0
    }
  }],
  imageUrl: String,
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for better query performance
roomSchema.index({ name: 1 });
roomSchema.index({ color: 1 });
roomSchema.index({ 'members.empId': 1 });
roomSchema.index({ 'members.role': 1 });
roomSchema.index({ 'lastMessage.timestamp': -1 });

// Update timestamp before saving
roomSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Room', roomSchema); 
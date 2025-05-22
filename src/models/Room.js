const mongoose = require('mongoose');

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
    empId: String,
    role: String
  }],
  admin: {
    empId: String,
    role: String
  },
  lastMessage: {
    message: String,
    sender: String,
    timestamp: Date,
    isoString: String
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
roomSchema.index({ admin: 1 });
roomSchema.index({ 'members.empId': 1 });
roomSchema.index({ 'admin.empId': 1 });
roomSchema.index({ 'lastMessage.timestamp': -1 });

// Update timestamp before saving
roomSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Room', roomSchema); 
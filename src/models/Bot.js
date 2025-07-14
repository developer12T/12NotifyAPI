const mongoose = require('mongoose');

const botSchema = new mongoose.Schema({
  employeeID: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  roomCount: {
    type: Number,
    required: true
  },
  requestCount: {
    type: Number,
    required: true
  },
  createdBy: {
    type: String,
    required: true
  },
  fcmToken: {
    type: String,
    default: null
  },
  deviceInfo: {
    platform: String,
    appVersion: String,
    deviceModel: String
  },
  lastTokenUpdate: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Bot', botSchema); 
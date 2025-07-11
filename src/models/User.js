const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  employeeID: {
    type: String,
    required: true,
    unique: true
  },
  role: {
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

module.exports = mongoose.model('User', userSchema); 
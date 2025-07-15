const mongoose = require('mongoose');

const appVersionSchema = new mongoose.Schema({
  min_version: {
    type: String,
    required: true,
    default: "1.0.0"
  },
  latest_version: {
    type: String,
    required: true,
    default: "1.2.3"
  },
  update_url: {
    type: String,
    required: true,
    default: "https://yourdomain.com/app-latest.apk"
  },
  platform: {
    type: String,
    enum: ['android', 'ios', 'both'],
    default: 'android'
  },
  force_update: {
    type: Boolean,
    default: false
  },
  update_message: {
    type: String,
    default: "กรุณาอัปเดตแอปพลิเคชันเป็นเวอร์ชันล่าสุด"
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Update the updated_at field before saving
appVersionSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('AppVersion', appVersionSchema); 
const mongoose = require('mongoose');

const directMessageSchema = new mongoose.Schema({
  // ผู้ส่งและผู้รับข้อความ
  participants: [{
    type: String, // employeeID
    required: true
  }],
  sender: {
    type: String, // employeeID
    required: true,
    index: true
  },
  // เนื้อหาข้อความ
  message: {
    type: String,
    required: function() {
      return !this.isImage && !this.isFile;
    },
    trim: true
  },
  // สถานะการอ่าน
  isRead: {
    type: Boolean,
    default: false
  },
  readBy: [{
    user: String,
    readAt: Date
  }],
  // ข้อมูลเวลาส่ง
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  // รองรับการส่งรูปภาพ
  isImage: {
    type: Boolean,
    default: false
  },
  imageUrl: {
    type: String,
    required: function() {
      return this.isImage;
    },
    default: null
  },
  // รองรับการส่งไฟล์
  isFile: {
    type: Boolean,
    default: false
  },
  fileUrl: {
    type: String,
    required: function() {
      return this.isFile;
    },
    default: null
  },
  fileName: {
    type: String,
    required: function() {
      return this.isFile;
    },
    default: null
  },
  fileType: {
    type: String,
    required: function() {
      return this.isFile;
    },
    default: null
  },
  // รองรับการตอบกลับข้อความ
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DirectMessage',
    default: null,
    index: true
  },
  // เก็บข้อมูลของข้อความที่ reply
  replyToMessage: {
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DirectMessage'
    },
    sender: String,
    message: String,
    isImage: {
      type: Boolean,
      default: false
    },
    imageUrl: String,
    isFile: {
      type: Boolean,
      default: false
    },
    fileUrl: String,
    fileName: String,
    fileType: String,
    createdAt: Date
  }
});

// Indexes for better query performance
directMessageSchema.index({ participants: 1, createdAt: -1 });
directMessageSchema.index({ sender: 1 });
directMessageSchema.index({ isRead: 1 });
directMessageSchema.index({ isImage: 1 });
directMessageSchema.index({ replyTo: 1 });
directMessageSchema.index({ 'replyToMessage.messageId': 1 });

// Virtual field สำหรับนับจำนวนการตอบกลับ
directMessageSchema.virtual('replyCount', {
  ref: 'DirectMessage',
  localField: '_id',
  foreignField: 'replyTo',
  count: true
});

// Method สำหรับ populate ข้อมูลการตอบกลับ
directMessageSchema.methods.populateReplyData = async function() {
  if (this.replyTo) {
    const replyToMessage = await mongoose.model('DirectMessage').findById(this.replyTo);
    if (replyToMessage) {
      this.replyToMessage = {
        messageId: replyToMessage._id, 
        sender: replyToMessage.sender,
        message: replyToMessage.message || '',
        isImage: replyToMessage.isImage || false,
        imageUrl: replyToMessage.imageUrl || null,
        isFile: replyToMessage.isFile || false,
        fileUrl: replyToMessage.fileUrl || null,
        fileName: replyToMessage.fileName || null,
        fileType: replyToMessage.fileType || null,
        createdAt: replyToMessage.createdAt
      };
    }
  }
  return this;
};

// Static method สำหรับสร้างข้อความตอบกลับ
directMessageSchema.statics.createReply = async function(replyData) {
  const { 
    participants,
    sender, 
    message, 
    replyToId, 
    isImage = false, 
    imageUrl = null,
    isFile = false,
    fileUrl = null,
    fileName = null,
    fileType = null
  } = replyData;
  
  // ตรวจสอบว่าข้อความต้นฉบับมีอยู่จริง
  const originalMessage = await this.findById(replyToId);
  if (!originalMessage) {
    throw new Error('ไม่พบข้อความต้นฉบับที่ต้องการตอบกลับ');
  }

  // ตรวจสอบว่าผู้ส่งและผู้รับตรงกับข้อความต้นฉบับ
  const originalParticipants = new Set(originalMessage.participants);
  const newParticipants = new Set(participants);
  if (![...originalParticipants].every(p => newParticipants.has(p))) {
    throw new Error('ไม่สามารถตอบกลับข้อความระหว่างผู้ใช้ที่แตกต่างกันได้');
  }

  // สร้างข้อความใหม่พร้อม reply data
  const newMessage = new this({
    participants,
    sender,
    message: isImage || isFile ? '' : message,
    isImage,
    imageUrl,
    isFile,
    fileUrl,
    fileName,
    fileType,
    replyTo: replyToId,
    replyToMessage: {
      messageId: originalMessage._id,
      sender: originalMessage.sender,
      message: originalMessage.message || '',
      isImage: originalMessage.isImage || false,
      imageUrl: originalMessage.imageUrl || null,
      isFile: originalMessage.isFile || false,
      fileUrl: originalMessage.fileUrl || null,
      fileName: originalMessage.fileName || null,
      fileType: originalMessage.fileType || null,
      createdAt: originalMessage.createdAt
    }
  });

  return await newMessage.save();
};

module.exports = mongoose.model('DirectMessage', directMessageSchema); 
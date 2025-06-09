const mongoose = require('mongoose');
const { getThaiTime } = require('../utils/timeUtils');

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
      return !this.isImage && !this.isFile; // Required only if not an image or file message
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
  // เพิ่ม fields สำหรับไฟล์
  isFile: {
    type: Boolean,
    default: false
  },
  fileUrl: {
    type: String,
    required: function() {
      return this.isFile; // Required only if it's a file message
    },
    default: null
  },
  fileName: {
    type: String,
    required: function() {
      return this.isFile; // Required only if it's a file message
    },
    default: null
  },
  fileType: {
    type: String,
    required: function() {
      return this.isFile; // Required only if it's a file message
    },
    default: null
  },

  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
    index: true
  },
  // เก็บข้อมูลของข้อความที่ reply เพื่อไม่ต้อง populate ทุกครั้ง
  replyToMessage: {
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message'
    },
    sender: String, // employeeID ของคนส่งข้อความต้นฉบับ
    message: String, // เนื้อหาข้อความต้นฉบับ (สำหรับ text)
    isImage: {
      type: Boolean,
      default: false
    },
    imageUrl: String, // URL รูปภาพ (สำหรับ image message)
    isFile: {
      type: Boolean,
      default: false
    },
    fileUrl: String, // URL ไฟล์ (สำหรับ file message)
    fileName: String, // ชื่อไฟล์ต้นฉบับ
    fileType: String, // ประเภทไฟล์
    createdAt: {
      type: Date,
      default: Date.now
    }
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
messageSchema.index({ replyTo: 1 }); // ✅ เพิ่ม index สำหรับ reply
messageSchema.index({ 'replyToMessage.messageId': 1 }); // ✅ เพิ่ม index

messageSchema.virtual('replyCount', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'replyTo',
  count: true
});

messageSchema.methods.populateReplyData = async function() {
  if (this.replyTo) {
    const replyToMessage = await mongoose.model('Message').findById(this.replyTo);
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

messageSchema.statics.createReply = async function(replyData) {
  const { 
    roomId, 
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

  // ตรวจสอบว่าข้อความต้นฉบับอยู่ในห้องเดียวกัน
  if (originalMessage.room.toString() !== roomId.toString()) {
    throw new Error('ไม่สามารถตอบกลับข้อความจากห้องอื่นได้');
  }

  // สร้างข้อความใหม่พร้อม reply data
  const newMessage = new this({
    room: roomId,
    sender,
    message: isImage || isFile ? '' : message,
    isImage,
    imageUrl,
    isFile,
    fileUrl,
    fileName,
    fileType,
    replyTo: replyToId,
    createdAt: Date.now(),
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


module.exports = mongoose.model('Message', messageSchema); 
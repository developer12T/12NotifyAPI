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
    createdAt: Date // วันที่ส่งข้อความต้นฉบับ
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
        createdAt: replyToMessage.createdAt
      };
    }
  }
  return this;
};

messageSchema.statics.createReply = async function(replyData) {
  const { roomId, sender, message, replyToId, isImage = false, imageUrl = null } = replyData;
  
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
    message: isImage ? '' : message,
    isImage,
    imageUrl,
    replyTo: replyToId,
    replyToMessage: {
      messageId: originalMessage._id,
      sender: originalMessage.sender,
      message: originalMessage.message || '',
      isImage: originalMessage.isImage || false,
      imageUrl: originalMessage.imageUrl || null,
      createdAt: originalMessage.createdAt
    }
  });

  return await newMessage.save();
};


module.exports = mongoose.model('Message', messageSchema); 
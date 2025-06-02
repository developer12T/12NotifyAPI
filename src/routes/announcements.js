const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const Announcement = require('../models/Announcement');
const User = require('../models/User');
const { getThaiTime, getThaiTimeISOString } = require('../utils/timeUtils');
const { findUserByEmployeeId } = require('../services/ldapServices');
const upload = require('../middleware/upload');

// Serve static files from uploads directory
router.use('/uploads', express.static(path.join(__dirname, '../../uploads/announcements')));

// Create a new announcement (Admin only)
router.post('/send', upload.single('image'), async (req, res) => {
  try {
    const { title, content, employeeID } = req.body;    

    // Verify user exists and is admin or HR
    const user = await User.findOne({ employeeID });
    // console.log(user.role);
    if (!user || !(user.role === 'admin' || user.role === 'Hr')) {
      // If there was a file uploaded, remove it
      if (req.file) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(403).json({ 
        statusCode: 403,
        message: 'เฉพาะผู้ดูแลระบบและ HR เท่านั้นที่สามารถสร้างประกาศได้' 
      });
    }

    const now = getThaiTime();
    const announcement = new Announcement({
      title: title ?? '',
      content: content ?? '',
      createdBy: employeeID,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      imageUrl: req.file ? `/uploads/announcements/${req.file.filename}` : null
    });

    await announcement.save();

    // Get user details for createdBy using LDAP
    const userDetails = await findUserByEmployeeId(employeeID);
    const userData = userDetails.success ? userDetails.user : null;

    console.log('📢 New announcement created:', {
      id: announcement._id,
      title: announcement.title,
      createdAt: announcement.createdAt
    });

    // Emit announcement with acknowledgment
    const io = req.app.get('io');
    if (io) {
      try {
        const chatIo = io.of('/chat');  // Add chat namespace
        const announcementData = {
          statusCode: 200,
          message: 'Announcement created successfully',
          data: {
            ...announcement.toObject(),
            createdByUser: userData
          }
        };

        // Emit to both namespaces
        io.emit('newAnnouncement', announcementData, (response) => {
          if (response && response.error) {
            console.error('Error broadcasting announcement to root namespace:', response.error);
          } else {
            console.log('📡 Emitted newAnnouncement event to root namespace');
          }
        });

        chatIo.emit('newAnnouncement', announcementData, (response) => {
          if (response && response.error) {
            console.error('Error broadcasting announcement to chat namespace:', response.error);
          } else {
            console.log('📡 Emitted newAnnouncement event to chat namespace');
          }
        });
      } catch (error) {
        console.error('Error emitting announcement:', error);
      }
    }

    res.json({
      statusCode: 200,
      message: 'Announcement created successfully',
      data: {
        ...announcement.toObject(),
        createdByUser: userData
      }
    });
  } catch (error) {
    // If there was a file uploaded and an error occurred, remove it
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error creating announcement:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการสร้างประกาศ',
      error: error.message 
    });
  }
});

// Get active announcements with pagination
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    const announcements = await Announcement.find(query).where('status').equals('active')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // Get user details for createdBy using LDAP
    const employeeIDs = [...new Set(announcements.map(a => a.createdBy))];
    const userPromises = employeeIDs.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    const total = await Announcement.countDocuments(query);

    const formattedAnnouncements = announcements.map(announcement => {
      const creator = userMap[announcement.createdBy];
      return {
        ...announcement.toObject(),
        // isoString: getThaiTimeISOString(announcement.createdAt),
        createdBy: creator ? {
          employeeID: creator.employeeID,
          fullName: creator.fullName,
          department: creator.department
        } : null
      };
    });

    res.json({
      statusCode: 200,
      announcements: formattedAnnouncements,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalAnnouncements: total 
      }
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลประกาศ',
      error: error.message 
    });
  }
});

// Get all announcements with pagination
router.get('/web', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    const announcements = await Announcement.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // Get user details for createdBy using LDAP
    const employeeIDs = [...new Set(announcements.map(a => a.createdBy))];
    const userPromises = employeeIDs.map(id => findUserByEmployeeId(id));
    const userResults = await Promise.all(userPromises);
    
    const userMap = userResults.reduce((map, result) => {
      if (result.success && result.user) {
        map[result.user.employeeID] = result.user;
      }
      return map;
    }, {});

    const total = await Announcement.countDocuments(query);

    const formattedAnnouncements = announcements.map(announcement => {
      const creator = userMap[announcement.createdBy];
      return {
        ...announcement.toObject(),
        // isoString: getThaiTimeISOString(announcement.createdAt),
        createdBy: creator ? {
          employeeID: creator.employeeID,
          fullName: creator.fullName,
          department: creator.department
        } : null
      };
    });

    res.json({
      statusCode: 200,
      announcements: formattedAnnouncements,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalAnnouncements: total 
      }
    });
  } catch (error) {
    console.error('Error fetching announcements:', error);
    res.status(500).json({ 
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการดึงข้อมูลประกาศ',
      error: error.message 
    });
  }
});

// Update announcement status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, employeeID } = req.body;

    // Verify user is admin or HR
    const user = await User.findOne({ employeeID });
    if (!user || !(user.role === 'admin' || user.role === 'Hr')) {
      return res.status(403).json({
        statusCode: 403,
        message: 'เฉพาะผู้ดูแลระบบและ HR เท่านั้นที่สามารถอัพเดทสถานะประกาศได้'
      });
    }

    const announcement = await Announcement.findOne({ _id:id });
    if (!announcement) {
      return res.status(404).json({
        statusCode: 404,
        message: 'Announcement not found'
      });
    }

    // If there's an old image and a new one is being uploaded, delete the old one
    if (announcement.imageUrl && req.file) {
      const oldImagePath = path.join(__dirname, '../../uploads', announcement.imageUrl);
      if (fs.existsSync(oldImagePath)) {
        fs.unlinkSync(oldImagePath);
      }
    }

    announcement.status = status;
    announcement.updatedAt = getThaiTime();
    if (req.file) {
      announcement.imageUrl = `/announcements/uploads/${req.file.filename}`;
    }
    await announcement.save();

    res.json({
      statusCode: 200,
      message: 'Announcement status updated successfully',
      data: {
        ...announcement.toObject(),
        isoString: getThaiTimeISOString(announcement.updatedAt)
      }
    });
  } catch (error) {
    // If there was a file uploaded and an error occurred, remove it
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error updating announcement status:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการอัพเดทสถานะประกาศ',
      error: error.message
    });
  }
});

// Update announcement details
router.patch('/:id', upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, status, employeeID } = req.body;

    // Verify user is admin or HR
    const user = await User.findOne({ employeeID });
    if (!user || !(user.role === 'admin' || user.role === 'Hr')) {
      return res.status(403).json({
        statusCode: 403,
        message: 'เฉพาะผู้ดูแลระบบและ HR เท่านั้นที่สามารถแก้ไขประกาศได้'
      });
    }

    const announcement = await Announcement.findOne({  id });
    if (!announcement) {
      return res.status(404).json({
        statusCode: 404,
        message: 'Announcement not found'
      });
    }

    // Update fields if provided
    if (title) announcement.title = title;
    if (content) announcement.content = content;
    if (status) announcement.status = status;
    announcement.updatedAt = getThaiTime();

    // Handle image update if new image is uploaded
    if (req.file) {
      // Delete old image if exists
      if (announcement.imageUrl) {
        const oldImagePath = path.join(__dirname, '../../uploads', announcement.imageUrl);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      announcement.imageUrl = `/uploads/announcements/${req.file.filename}`;
    }

    await announcement.save();

    res.json({
      statusCode: 200,
      message: 'Announcement updated successfully',
      data: {
        ...announcement.toObject(),
        isoString: getThaiTimeISOString(announcement.updatedAt)
      }
    });
  } catch (error) {
    // If there was a file uploaded and an error occurred, remove it
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    console.error('Error updating announcement:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการแก้ไขประกาศ',
      error: error.message
    });
  }
});

// Delete announcement
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { employeeID } = req.body;

    // Verify user is admin or HR
    const user = await User.findOne({ employeeID });
    if (!user || !(user.role === 'admin' || user.role === 'Hr')) {
      return res.status(403).json({
        statusCode: 403,
        message: 'เฉพาะผู้ดูแลระบบและ HR เท่านั้นที่สามารถลบประกาศได้'
      });
    }

    const announcement = await Announcement.findOne({ id });
    if (!announcement) {
      return res.status(404).json({
        statusCode: 404,
        message: 'Announcement not found'
      });
    }

    // Delete associated image if exists
    if (announcement.imageUrl) {
      const imagePath = path.join(__dirname, '../../uploads', announcement.imageUrl);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    await announcement.deleteOne();

    res.json({
      statusCode: 200,
      message: 'Announcement deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting announcement:', error);
    res.status(500).json({
      statusCode: 500,
      message: 'เกิดข้อผิดพลาดในการลบประกาศ',
      error: error.message
    });
  }
});

module.exports = router; 
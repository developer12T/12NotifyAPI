const express = require('express');
const router = express.Router();
const User = require('../models/User');
const ldap = require('ldapjs');
const { authenticateLDAP } = require('../services/ldapServices');
const jwt = require('jsonwebtoken');

// Login user
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

     if (!username || !password) {
        return res.status(400).json({ statusCode: 400, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }

    const result = await authenticateLDAP(username, password);

    if (result.success) {
      // สร้าง token
      const token = jwt.sign(
        { 
          employeeID: result.entries.employeeID,
          username: result.entries.username,
          department: result.entries.department
        },
        process.env.JWT_SECRET || 'your-secret-key',
        { expiresIn: '24h' }
      );
      
      return res.status(200).json({ 
        statusCode: 200, 
        data: result.entries,
        token: token
      });
    } else {
      res.status(401).json({ statusCode: 401, message: 'เข้าสู่ระบบไม่สำเร็จ' });
    }

  } catch (error) {
    console.error('LDAP Login Error:', error);
    res.status(500).json({ 
      message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ',
      error: error.message,
      details: error.lde_message || 'ไม่พบรายละเอียดเพิ่มเติม'
    });
  }
});

module.exports = router; 


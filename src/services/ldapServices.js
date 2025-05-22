const ldap = require('ldapjs');
require('dotenv').config();

const LDAP_BASE_DN = process.env.LDAP_BASE_DN;
const LDAP_BIND_DN = process.env.LDAP_BIND_DN;
const LDAP_BIND_PASSWORD = process.env.LDAP_BIND_PASSWORD;

// เพิ่มฟังก์ชันสำหรับแปลงข้อมูล
function transformEntryFormat(entries) {
  return entries.map(entry => {
    // สร้าง object เก็บข้อมูลชั่วคราว
    const tempEntry = {};
    entry.forEach(attr => {
      if (attr.values && attr.values.length > 0) {
        // แปลงชื่อ key ตามที่ต้องการ
        switch(attr.type) {
          case 'employeeID':
            tempEntry.employeeID = attr.values[0];
            break;
          case 'sAMAccountName':
            tempEntry.userName = attr.values[0];
            break;
          case 'givenName':
            tempEntry.firstName = attr.values[0];
            break;
          case 'sn':
            tempEntry.lastName = attr.values[0];
            break;
          case 'displayName':
            tempEntry.fullName = attr.values[0];
            break;
          case 'description':
            tempEntry.fullNameThai = attr.values[0];
            break;
          case 'mail':
            tempEntry.mail = attr.values[0];
            break;  
            case 'dn':
            tempEntry.dn = attr.values[0];
            break;
            case 'title':
            tempEntry.title = attr.values[0];
            break;
            case 'department':
            tempEntry.department = attr.values[0];
            break;
            case 'company':
            tempEntry.company = attr.values[0];
            break;
            case 'distinguishedName':
            // tempEntry.distinguishedName = attr.values[0];
            tempEntry.distinguishedName = extractOU(attr.values[0]) == 'User Resign' ? 0 : 1;
            break;
            

        }
      }
    });

    // สร้าง object ใหม่ตามลำดับที่ต้องการ
    return {
      employeeID: tempEntry.employeeID ?? null,
      userName: tempEntry.userName ?? null,
      firstName: tempEntry.firstName ?? null,
      lastName: tempEntry.lastName ?? null,
      fullName: tempEntry.fullName ?? null,
      fullNameThai: tempEntry.fullNameThai ?? null,
      mail: tempEntry.mail ?? null,
      imgUrl: `http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/${tempEntry.employeeID}.jpg`,
      positon: tempEntry.title ?? null,
      department: tempEntry.department ?? null,
      company: tempEntry.company ?? null,
      status: tempEntry.distinguishedName ?? 0,
    };
  });
}

// เพิ่มฟังก์ชันสำหรับกรองข้อมูล
function filterEntriesWithEmployeeID(entries) {
  return entries.filter(entry => {
    // ตรวจสอบว่ามี employeeID หรือไม่
    return entry.some(attr => attr.type === 'employeeID' && attr.values && attr.values.length > 0);
  });
}

function authenticateLDAP(username, password) {
  return new Promise((resolve, reject) => {
    console.log('เริ่มการตรวจสอบ LDAP สำหรับผู้ใช้:', username);
    
    // สร้างการเชื่อมต่อ LDAP
    const client = ldap.createClient({
      url: process.env.LDAP_URL,
      timeout: 5000,
      connectTimeout: 10000
    });
    
    // เพิ่ม event handlers สำหรับการดูข้อผิดพลาด
    client.on('error', (err) => {
      console.error('LDAP client error:', err);
    });
    
    client.on('connectError', (err) => {
      console.error('LDAP connection error:', err);
    });

    // ขั้นตอนที่ 1: เชื่อมต่อด้วย service account
    console.log('กำลังทำการ Bind กับ:', LDAP_BIND_DN);
    client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
      if (bindErr) {
        console.error('LDAP service bind error:', bindErr);
        client.unbind();
        resolve({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ LDAP: ' + bindErr.message });
        return;
      }
      
      console.log('Bind สำเร็จ กำลังค้นหาผู้ใช้...');

      // ใช้ filter ที่รวมทุกเงื่อนไขเลย
      const userFilter = `(&(objectClass=user)(|(sAMAccountName=${username})(userPrincipalName=${username}@onetwotrading.co.th)(mail=${username}@onetwotrading.co.th)))`;
    //   console.log('ใช้ filter:', userFilter);
    //   console.log('ค้นหาใน base DN:', LDAP_BASE_DN);
      
      const opts = {
        filter: userFilter,
        scope: 'sub',
        attributes: ['employeeID','sAMAccountName','givenName','sn','displayName','description','mail','userPrincipalName','title','department','company','distinguishedName']
      };

      client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
        if (searchErr) {
        //   console.error('LDAP search error:', searchErr);
          client.unbind();
          resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหาผู้ใช้: ' + searchErr.message });
          return;
        }

        let userDN = null;
        const entries = [];

        res.on('searchEntry', (entry) => {
        //   console.log('พบรายการ:', JSON.stringify(entry.pojo.attributes, null, 2));
          // แปลง DN object เป็น string
          const dnString = entry.objectName.toString();
        //   console.log('DN ของรายการ:', dnString);
          entries.push(entry.pojo.attributes);
          userDN = dnString;
        //   console.log('พบ DN ของผู้ใช้:', userDN);
        });

        res.on('error', (err) => {
          console.error('Search error:', err);
        });

        res.on('end', () => {
          if (!userDN) {
            console.log('ไม่พบผู้ใช้ในระบบ');
            client.unbind();
            resolve({ success: false, message: 'ไม่พบผู้ใช้ในระบบ' });
            return;
          }

          // ตรวจสอบรหัสผ่านด้วย DN ที่พบ
          verifyPassword(client, userDN, password, entries, resolve);
        });
      });
    });
  });
}

// แยกฟังก์ชันตรวจสอบรหัสผ่านออกมา
function verifyPassword(client, userDN, password, entries, resolve) {
  console.log('กำลังตรวจสอบรหัสผ่านสำหรับ DN:', userDN);
  
  // ปิดการเชื่อมต่อเก่าก่อนทำการ bind ใหม่
  client.unbind((unbindErr) => {
    if (unbindErr) {
      console.error('Error unbinding:', unbindErr);
    }
    
    // สร้างการเชื่อมต่อใหม่
    const newClient = ldap.createClient({
      url: process.env.LDAP_URL,
      timeout: 5000,
      connectTimeout: 10000
    });

    // ทำการ bind ด้วย DN ของผู้ใช้
    newClient.bind(userDN, password, (userBindErr) => {
      if (userBindErr) {
        console.error('รหัสผ่านไม่ถูกต้อง:', userBindErr);
        newClient.unbind();
        resolve({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
        return;
      }

    //   console.log('รหัสผ่านถูกต้อง');
      
      // กรองและแปลงข้อมูล
    //   const filteredEntries = filterEntriesWithEmployeeID(entries);
      const transformedEntries = transformEntryFormat(entries);
    console.log('entries',transformedEntries);

      newClient.unbind();
      resolve({
        success: true,
        entries: transformedEntries
      });
    });
  });
}

function readLDAP(username, password) {
    return new Promise((resolve, reject) => {
      console.log('เริ่มการตรวจสอบ LDAP สำหรับผู้ใช้:', username);
      
      // สร้างการเชื่อมต่อ LDAP
      const client = ldap.createClient({
        url: process.env.LDAP_URL,  // แก้ไขเป็น URL ของเซิร์ฟเวอร์ LDAP ของคุณ
        timeout: 5000, // เพิ่ม timeout
        connectTimeout: 10000 // เพิ่ม connection timeout
      });
      
      // เพิ่ม event handlers สำหรับการดูข้อผิดพลาด
      client.on('error', (err) => {
        console.error('LDAP client error:', err);
      });
      
      client.on('connectError', (err) => {
        console.error('LDAP connection error:', err);
      });
  
      // ใช้ LDAP_BIND_DN และรหัสผ่านเพื่อเชื่อมต่อกับ LDAP ก่อน (bind)
      console.log('กำลังทำการ Bind กับ:', LDAP_BIND_DN);
      client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
        if (bindErr) {
          console.error('LDAP service bind error:', bindErr);
          client.unbind();
          resolve({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ LDAP: ' + bindErr.message });
          return;
        }
        
        console.log('Bind สำเร็จ กำลังค้นหาผู้ใช้...');
  
        // ลองใช้หลายวิธีในการค้นหาผู้ใช้ของ Active Directory
        // อาจมีการใช้รูปแบบต่างๆกันในแต่ละองค์กร
        const filter = '(objectClass=*)';
        console.log('ใช้ filter:', filter);
        console.log('ค้นหาใน base DN:', LDAP_BASE_DN);
        
        const opts = {
          filter: filter,
          scope: 'sub',
          sizeLimit: 1000,
          attributes: ['employeeID','sAMAccountName','givenName','sn','displayName','description','mail','dn','title','department','company','distinguishedName']  // ดึงทุก attributes
        //   attributes: ['employeeID']  // ดึงทุก attributes
          // attributes: ['*']  // ดึงทุก attributes
        };
  
        client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
          if (searchErr) {
            console.error('LDAP search error:', searchErr);
            client.unbind();
            resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหาผู้ใช้: ' + searchErr.message });
            return;
          }
  
          const entries = [];
  
          res.on('searchEntry', (entry) => {
            // console.log('พบรายการ:', entry.pojo.attributes);
            entries.push(entry.pojo.attributes);
          });
  
          res.on('error', (err) => {
            console.error('Search error:', err);
          });
  
          res.on('end', (result) => {
            console.log('การค้นหาเสร็จสิ้น, พบทั้งหมด:', entries.length, 'รายการ');
            
            if (entries.length === 0) {
              console.log('ไม่พบข้อมูล');
              client.unbind();
              resolve({ success: false, message: 'ไม่พบข้อมูลในระบบ' });
              return;
            }
  
            // กรองข้อมูลก่อนส่งกลับ
            const filteredEntries = filterEntriesWithEmployeeID(entries);
            console.log('จำนวนรายการหลังกรอง:', filteredEntries.length);
  
            // แปลงรูปแบบข้อมูล
            const transformedEntries = transformEntryFormat(filteredEntries);

            
  
            client.unbind();
            resolve({
              success: true,
              entries: transformedEntries
            });
          });
        });
      });
    });
  }

  function readAllLDAP() {
    return new Promise((resolve, reject) => {
      
      // สร้างการเชื่อมต่อ LDAP
      const client = ldap.createClient({
        url: process.env.LDAP_URL,  // แก้ไขเป็น URL ของเซิร์ฟเวอร์ LDAP ของคุณ
        timeout: 5000, // เพิ่ม timeout
        connectTimeout: 10000 // เพิ่ม connection timeout
      });
      
      // เพิ่ม event handlers สำหรับการดูข้อผิดพลาด
      client.on('error', (err) => {
        console.error('LDAP client error:', err);
      });
      
      client.on('connectError', (err) => {
        console.error('LDAP connection error:', err);
      }); 
  
      // ใช้ LDAP_BIND_DN และรหัสผ่านเพื่อเชื่อมต่อกับ LDAP ก่อน (bind)
      console.log('กำลังทำการ Bind กับ:', LDAP_BIND_DN);
      client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
        if (bindErr) {
          console.error('LDAP service bind error:', bindErr);
          client.unbind();
          resolve({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ LDAP: ' + bindErr.message });
          return;
        }
        
        console.log('Bind สำเร็จ กำลังค้นหาผู้ใช้...');
  
        // ลองใช้หลายวิธีในการค้นหาผู้ใช้ของ Active Directory
        // อาจมีการใช้รูปแบบต่างๆกันในแต่ละองค์กร
        const filter = '(objectClass=*)';
        console.log('ใช้ filter:', filter);
        console.log('ค้นหาใน base DN:', LDAP_BASE_DN);
        
        const opts = {
          filter: filter,
          scope: 'sub',
          sizeLimit: 1000,
          attributes: ['*']  // ดึงทุก attributes
        //   attributes: ['employeeID']  // ดึงทุก attributes
          // attributes: ['*']  // ดึงทุก attributes
        };
  
        client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
          if (searchErr) {
            console.error('LDAP search error:', searchErr);
            client.unbind();
            resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหาผู้ใช้: ' + searchErr.message });
            return;
          }
  
          const entries = [];
  
          res.on('searchEntry', (entry) => {
            // console.log('พบรายการ:', entry.pojo.attributes);
            entries.push(entry.pojo.attributes);
          });
  
          res.on('error', (err) => {
            console.error('Search error:', err);
          });
  
          res.on('end', (result) => {
            console.log('การค้นหาเสร็จสิ้น, พบทั้งหมด:', entries.length, 'รายการ');
            
            if (entries.length === 0) {
              console.log('ไม่พบข้อมูล');
              client.unbind();
              resolve({ success: false, message: 'ไม่พบข้อมูลในระบบ' });
              return;
            }
  
            // กรองข้อมูลก่อนส่งกลับ
            const filteredEntries = filterEntriesWithEmployeeID(entries);
            console.log('จำนวนรายการหลังกรอง:', filteredEntries.length);
  
            // แปลงรูปแบบข้อมูล
            // const transformedEntries = transformEntryFormat(filteredEntries);

            
  
            client.unbind();
            resolve({
              success: true,
              entries: filteredEntries
            });
          });
        });
      });
    });
  }
  
  

// Function to extract OU from distinguishedName
function extractOU(dn) {
  const ouMatch = dn.match(/OU=([^,]+)/);
  return ouMatch ? ouMatch[1] : null;
}

async function searchUsers(filter) {
  return new Promise((resolve, reject) => {
    const tempEntries = [];
    client.search(LDAP_BASE_DN, {
      filter: filter,
      scope: 'sub',
      attributes: ['cn', 'employeeID', 'distinguishedName']
    }, (err, res) => {
      if (err) {
        console.error('LDAP search error:', err);
        reject(err);
        return;
      }

      res.on('searchEntry', (entry) => {
        const tempEntry = {};
        entry.attributes.forEach((attr) => {
          if (attr.type === 'distinguishedName') {
            tempEntry.distinguishedName = attr.values[0];
            // Extract OU from distinguishedName
            tempEntry.ou = extractOU(attr.values[0]);
          } else {
            tempEntry[attr.type] = attr.values[0];
          }
        });
        tempEntries.push(tempEntry);
      });

      res.on('end', () => {
        resolve(tempEntries);
      });

      res.on('error', (err) => {
        console.error('LDAP search error:', err);
        reject(err);
      });
    });
  });
}

function findUserByEmployeeId(employeeId) {
  return new Promise((resolve, reject) => {
    // console.log('ค้นหาผู้ใช้ด้วย Employee ID:', employeeId);
    
    const client = ldap.createClient({
      url: process.env.LDAP_URL,
      timeout: 5000,
      connectTimeout: 10000
    });
    
    client.on('error', (err) => {
      console.error('LDAP client error:', err);
    });
    
    client.on('connectError', (err) => {
      console.error('LDAP connection error:', err);
    });

    client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
      if (bindErr) {
        console.error('LDAP service bind error:', bindErr);
        client.unbind();
        resolve({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ LDAP: ' + bindErr.message });
        return;
      }
      
      // console.log('Bind สำเร็จ กำลังค้นหาผู้ใช้...');

      // สร้าง filter สำหรับค้นหาเฉพาะ employeeID ที่ต้องการ
      const filter = `(&(objectClass=*)(employeeID=${employeeId}))`;
      // console.log('ใช้ filter:', filter);
      
      const opts = {
        filter: filter,
        scope: 'sub',
        sizeLimit: 1, // ต้องการเพียง 1 รายการ
        attributes: [
          'employeeID',
          'sAMAccountName',
          'givenName',
          'sn',
          'displayName',
          'description',
          'mail',
          'dn',
          'title',
          'department',
          'company',
          'distinguishedName'
        ]
      };

      client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
        if (searchErr) {
          console.error('LDAP search error:', searchErr);
          client.unbind();
          resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหาผู้ใช้: ' + searchErr.message });
          return;
        }

        let userEntry = null;

        res.on('searchEntry', (entry) => {
          userEntry = entry.pojo.attributes;
        });

        res.on('error', (err) => {
          console.error('Search error:', err);
        });

        res.on('end', (result) => {
          client.unbind();
          
          if (!userEntry) {
            resolve({ 
              success: false, 
              message: `ไม่พบผู้ใช้ที่มี Employee ID: ${employeeId}` 
            });
            return;
          }

          // แปลงข้อมูลให้อยู่ในรูปแบบเดียวกับที่ใช้ในระบบ
          const transformedEntry = transformEntryFormat([userEntry])[0];
          
          // เพิ่ม imgUrl เข้าไปในข้อมูลผู้ใช้
          const userWithImage = {
            ...transformedEntry,
            imgUrl: `http://58.181.206.156:8080/12Trading/HR/assets/imgs/employee_picture/${transformedEntry.employeeID}.jpg`
          };
          
          resolve({
            success: true,
            user: userWithImage
          });
        });
      });
    });
  });
}

module.exports = {
  authenticateLDAP,
  readAllLDAP,
  readLDAP,
  filterEntriesWithEmployeeID,
  transformEntryFormat,
  findUserByEmployeeId,
  searchUsers
}; 
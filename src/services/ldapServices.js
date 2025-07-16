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
      imgUrl: `https://main.onetwotrading.co.th/12Trading/HR/assets/imgs/employee_picture/${tempEntry.employeeID}.jpg`,
      positon: tempEntry.title ?? null,
      department: tempEntry.department ?? null,
      company: tempEntry.company ?? null,
      status: tempEntry.distinguishedName ?? 0,
      dn: tempEntry.dn ?? null,
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
      
      const opts = {
        filter: userFilter,
        scope: 'sub',
        attributes: ['employeeID','sAMAccountName','givenName','sn','displayName','description','mail','userPrincipalName','title','department','company','distinguishedName']
      };

      client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
        if (searchErr) {
          client.unbind();
          resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหาผู้ใช้: ' + searchErr.message });
          return;
        }

        let userDN = null;
        const entries = [];

        res.on('searchEntry', (entry) => {
          const dnString = entry.objectName.toString();
          entries.push(entry.pojo.attributes);
          userDN = dnString;
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

      // กรองและแปลงข้อมูล
      const transformedEntries = transformEntryFormat(entries);
      console.log('entries', transformedEntries);

      newClient.unbind();
      resolve({
        success: true,
        entries: transformedEntries
      });
    });
  });
}

// ปรับปรุงฟังก์ชัน readLDAP เพื่อจัดการ Size Limit
function readLDAP(username, password) {
  return new Promise((resolve, reject) => {
    console.log('เริ่มการอ่านข้อมูล LDAP');
    
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

    console.log('กำลังทำการ Bind กับ:', LDAP_BIND_DN);
    client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
      if (bindErr) {
        console.error('LDAP service bind error:', bindErr);
        client.unbind();
        resolve({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ LDAP: ' + bindErr.message });
        return;
      }
      
      console.log('Bind สำเร็จ กำลังค้นหาผู้ใช้...');

      // ใช้ filter ที่เฉพาะเจาะจงมากขึ้น เพื่อหลีกเลี่ยง Size Limit
      const filter = '(&(objectClass=user)(employeeID=*))'; // ค้นหาเฉพาะ user ที่มี employeeID
      console.log('ใช้ filter:', filter);
      
      const opts = {
        filter: filter,
        scope: 'sub',
        sizeLimit: 0, // ไม่จำกัดขนาด หรือใช้ 1000
        timeLimit: 30, // เพิ่มเวลาเป็น 30 วินาที
        paged: true, // ใช้ paged results เพื่อจัดการข้อมูลจำนวนมาก
        attributes: ['employeeID','sAMAccountName','givenName','sn','displayName','description','mail','dn','title','department','company','distinguishedName']
      };

      client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
        if (searchErr) {
          console.error('LDAP search error:', searchErr);
          client.unbind();
          resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหา: ' + searchErr.message });
          return;
        }

        const entries = [];

        res.on('searchEntry', (entry) => {
          entries.push(entry.pojo.attributes);
        });

        res.on('error', (err) => {
          console.error('Search error:', err);
          // แม้จะเกิด error ก็ยังคืนข้อมูลที่ได้มาแล้ว
          if (entries.length > 0) {
            console.log('ได้ข้อมูลบางส่วน:', entries.length, 'รายการ');
            processResults();
          } else {
            client.unbind();
            resolve({ success: false, message: 'เกิดข้อผิดพลาดในการค้นหา: ' + err.message });
          }
        }); 

        res.on('end', (result) => {
          console.log('การค้นหาเสร็จสิ้น, พบทั้งหมด:', entries.length, 'รายการ');
          processResults();
        });

        function processResults() {
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
        }
      });
    });
  });
}

// ปรับปรุงฟังก์ชัน readAllLDAP เพื่อใช้ paging
function readAllLDAP() {
  return new Promise((resolve, reject) => {
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

    console.log('กำลังทำการ Bind กับ:', LDAP_BIND_DN);
    client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
      if (bindErr) {
        console.error('LDAP service bind error:', bindErr);
        client.unbind();
        resolve({ success: false, message: 'เกิดข้อผิดพลาดในการเชื่อมต่อกับบริการ LDAP: ' + bindErr.message });
        return;
      }
      
      console.log('Bind สำเร็จ กำลังค้นหาข้อมูลทั้งหมด...');

      // ใช้ multiple queries เพื่อหลีกเลี่ยง size limit
      const queries = [
        '(&(objectClass=user)(employeeID=*))',  // User accounts with employee ID
        '(&(objectClass=person)(employeeID=*))', // Person objects with employee ID
        '(&(objectClass=organizationalPerson)(employeeID=*))' // Organizational persons with employee ID
      ];

      let allEntries = [];
      let completedQueries = 0;

      queries.forEach((filter, index) => {
        console.log(`กำลังค้นหาด้วย filter ${index + 1}:`, filter);
        
        const opts = {
          filter: filter,
          scope: 'sub',
          sizeLimit: 1000, // จำกัด 1000 รายการต่อ query
          timeLimit: 30,
          attributes: ['*'] // ดึงทุก attributes
        };

        client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
          if (searchErr) {
            console.error(`LDAP search error for query ${index + 1}:`, searchErr);
            completedQueries++;
            if (completedQueries === queries.length) {
              finishSearch();
            }
            return;
          }

          const queryEntries = [];

          res.on('searchEntry', (entry) => {
            queryEntries.push(entry.pojo.attributes);
          });

          res.on('error', (err) => {
            console.error(`Search error for query ${index + 1}:`, err);
          });

          res.on('end', () => {
            console.log(`Query ${index + 1} เสร็จสิ้น, พบ:`, queryEntries.length, 'รายการ');
            allEntries = allEntries.concat(queryEntries);
            completedQueries++;
            
            if (completedQueries === queries.length) {
              finishSearch();
            }
          });
        });
      });

      function finishSearch() {
        console.log('การค้นหาทั้งหมดเสร็จสิ้น, พบทั้งหมด:', allEntries.length, 'รายการ');
        
        if (allEntries.length === 0) {
          console.log('ไม่พบข้อมูล');
          client.unbind();
          resolve({ success: false, message: 'ไม่พบข้อมูลในระบบ' });
          return;
        }

        // กรองข้อมูลที่ซ้ำกัน (based on employeeID)
        const uniqueEntries = [];
        const seenEmployeeIDs = new Set();

        allEntries.forEach(entry => {
          const employeeIDAttr = entry.find(attr => attr.type === 'employeeID');
          if (employeeIDAttr && employeeIDAttr.values && employeeIDAttr.values.length > 0) {
            const employeeID = employeeIDAttr.values[0];
            if (!seenEmployeeIDs.has(employeeID)) {
              seenEmployeeIDs.add(employeeID);
              uniqueEntries.push(entry);
            }
          }
        });

        console.log('จำนวนรายการหลังลบข้อมูลซ้ำ:', uniqueEntries.length);

        client.unbind();
        resolve({
          success: true,
          entries: uniqueEntries
        });
      }
    });
  });
}

// เพิ่มฟังก์ชันสำหรับค้นหาแบบ paged
function searchLDAPWithPaging(filter, pageSize = 100) {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({
      url: process.env.LDAP_URL,
      timeout: 10000,
      connectTimeout: 15000
    });

    client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
      if (bindErr) {
        client.unbind();
        resolve({ success: false, message: 'Bind error: ' + bindErr.message });
        return;
      }

      const allEntries = [];
      let pageCount = 0;

      function searchPage(cookie = null) {
        pageCount++;
        console.log(`กำลังค้นหาหน้าที่ ${pageCount}...`);

        const opts = {
          filter: filter,
          scope: 'sub',
          sizeLimit: pageSize,
          attributes: ['employeeID','sAMAccountName','givenName','sn','displayName','description','mail','dn','title','department','company','distinguishedName']
        };

        // เพิ่ม paged control หากมี cookie
        if (cookie) {
          opts.controls = [
            new ldap.PagedResultsControl({ value: { size: pageSize, cookie: cookie } })
          ];
        } else {
          opts.controls = [
            new ldap.PagedResultsControl({ value: { size: pageSize } })
          ];
        }

        client.search(LDAP_BASE_DN, opts, (searchErr, res) => {
          if (searchErr) {
            console.error('Search page error:', searchErr);
            client.unbind();
            resolve({ success: false, message: 'Search error: ' + searchErr.message });
            return;
          }

          const pageEntries = [];
          let nextCookie = null;

          res.on('searchEntry', (entry) => {
            pageEntries.push(entry.pojo.attributes);
          });

          res.on('page', (result) => {
            // จัดการ page control response
            if (result.controls && result.controls.length > 0) {
              const pageControl = result.controls.find(control => 
                control instanceof ldap.PagedResultsControl
              );
              if (pageControl && pageControl.value.cookie && pageControl.value.cookie.length > 0) {
                nextCookie = pageControl.value.cookie;
              }
            }
          });

          res.on('error', (err) => {
            console.error('Page search error:', err);
          });

          res.on('end', () => {
            allEntries.push(...pageEntries);
            console.log(`หน้าที่ ${pageCount} เสร็จสิ้น, พบ ${pageEntries.length} รายการ`);

            // ถ้ามี cookie แสดงว่ายังมีหน้าถัดไป
            if (nextCookie) {
              searchPage(nextCookie);
            } else {
              // ค้นหาเสร็จสิ้นแล้ว
              console.log('การค้นหาทั้งหมดเสร็จสิ้น, พบทั้งหมด:', allEntries.length, 'รายการ');
              
              const filteredEntries = filterEntriesWithEmployeeID(allEntries);
              const transformedEntries = transformEntryFormat(filteredEntries);

              client.unbind();
              resolve({
                success: true,
                entries: transformedEntries
              });
            }
          });
        });
      }

      // เริ่มการค้นหาหน้าแรก
      searchPage();
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
    const client = ldap.createClient({
      url: process.env.LDAP_URL,
      timeout: 5000,
      connectTimeout: 10000
    });

    client.bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD, (bindErr) => {
      if (bindErr) {
        reject(bindErr);
        return;
      }

      const tempEntries = [];
      client.search(LDAP_BASE_DN, {
        filter: filter,
        scope: 'sub',
        sizeLimit: 100, // จำกัดจำนวนผลลัพธ์
        attributes: ['cn', 'employeeID', 'distinguishedName']
      }, (err, res) => { 
        if (err) {
          console.error('LDAP search error:', err);
          client.unbind();
          reject(err);
          return;
        }

        res.on('searchEntry', (entry) => {
          const tempEntry = {};
          entry.attributes.forEach((attr) => {
            if (attr.type === 'distinguishedName') {
              tempEntry.distinguishedName = attr.values[0];
              tempEntry.ou = extractOU(attr.values[0]);
            } else {
              tempEntry[attr.type] = attr.values[0];
            }
          });
          tempEntries.push(tempEntry);
        });

        res.on('end', () => {
          client.unbind();
          resolve(tempEntries);
        });

        res.on('error', (err) => {
          console.error('LDAP search error:', err);
          client.unbind();
          reject(err);
        });
      });
    });
  });
}

function findUserByEmployeeId(employeeId) {
  return new Promise((resolve, reject) => {
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

      // สร้าง filter สำหรับค้นหาเฉพาะ employeeID ที่ต้องการ
      const filter = `(&(objectClass=user)(employeeID=${employeeId}))`;
      
      const opts = {
        filter: filter,
        scope: 'sub',
        sizeLimit: 1, // ต้องการเพียง 1 รายการ
        timeLimit: 10, // จำกัดเวลา 10 วินาที
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
          resolve({ 
            success: false, 
            message: 'เกิดข้อผิดพลาดในการค้นหาผู้ใช้: ' + searchErr.message 
          });
          return;
        }

        handleSearchResult(res, employeeId, client, resolve);
      });
    });
  });
}

// แยกฟังก์ชันจัดการผลลัพธ์การค้นหาออกมา
function handleSearchResult(res, employeeId, client, resolve) {
  let userEntry = null;

  res.on('searchEntry', (entry) => {
    userEntry = entry.pojo.attributes;
  });

  res.on('error', (err) => {
    console.error('Search result error:', err);
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

    try {
      // แปลงข้อมูลให้อยู่ในรูปแบบเดียวกับที่ใช้ในระบบ
      const transformedEntry = transformEntryFormat([userEntry])[0];
      
      // เพิ่ม imgUrl เข้าไปในข้อมูลผู้ใช้
      const userWithImage = {
        ...transformedEntry,
        imgUrl: `https://main.onetwotrading.co.th/12Trading/HR/assets/imgs/employee_picture/${transformedEntry.employeeID}.jpg`
      };
      
      resolve({
        success: true,
        user: userWithImage
      });
    } catch (error) {
      console.error('Error transforming user data:', error);
      resolve({ 
        success: false, 
        message: 'เกิดข้อผิดพลาดในการประมวลผลข้อมูลผู้ใช้' 
      });
    }
  });
}

module.exports = {
  authenticateLDAP,
  readAllLDAP,
  readLDAP,
  filterEntriesWithEmployeeID,
  transformEntryFormat,
  findUserByEmployeeId,
  searchUsers,
  searchLDAPWithPaging // เพิ่มฟังก์ชันใหม่
};

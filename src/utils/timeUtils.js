const getThaiTime = () => {
  const now = new Date();
  return new Date(now.getTime() + (7 * 60 * 60 * 1000)); // Add 7 hours for Thai timezone
};

const getThaiTimeISOString = (date) => {
  const thaiDate = date ? new Date(date.getTime() + (7 * 60 * 60 * 1000)) : getThaiTime();
  return thaiDate.toISOString();
};

const formatThaiDateTime = (date) => {
  const thaiDate = date ? new Date(date.getTime() + (7 * 60 * 60 * 1000)) : getThaiTime();
  
  const day = String(thaiDate.getDate()).padStart(2, '0');
  const month = String(thaiDate.getMonth() + 1).padStart(2, '0');
  const year = thaiDate.getFullYear();
  const hours = String(thaiDate.getHours()).padStart(2, '0');
  const minutes = String(thaiDate.getMinutes()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}`;
};

const formatThaiDateTimeDirectMessage = (date) => {
  const thaiDate = date ? new Date(date.getTime()) : getThaiTime();
  
  const day = String(thaiDate.getDate()).padStart(2, '0');
  const month = String(thaiDate.getMonth() + 1).padStart(2, '0');
  const year = thaiDate.getFullYear();
  const hours = String(thaiDate.getHours()).padStart(2, '0');
  const minutes = String(thaiDate.getMinutes()).padStart(2, '0');

  return `${day}/${month}/${year} ${hours}:${minutes}`;
};

module.exports = {
  getThaiTime,
  getThaiTimeISOString,
  formatThaiDateTime,
  formatThaiDateTimeDirectMessage
}; 
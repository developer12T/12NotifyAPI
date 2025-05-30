const mongoose = require('mongoose');

// Function to generate announcement ID
async function generateAnnouncementId() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const datePrefix = `${yyyy}${mm}${dd}`;

  // Find the latest announcement for today
  const latestAnnouncement = await mongoose.model('Announcement').findOne(
    { id: new RegExp(`^${datePrefix}`) },
    { id: 1 },
    { sort: { id: -1 } }
  );

  let sequence = 1;
  if (latestAnnouncement) {
    // Extract the sequence number and increment
    const lastSequence = parseInt(latestAnnouncement.id.slice(-3));
    sequence = lastSequence + 1;
  }

  // Format the new ID: yyyymmdd + 3-digit sequence
  return `${datePrefix}${String(sequence).padStart(3, '0')}`;
}

const announcementSchema = new mongoose.Schema({
  id: { 
    type: String,
    unique: true,
    sparse: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  imageUrl: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'draft'],
    required: true,
    default: 'active'
  },
  createdBy: {
    type: String,
    required: true,
    validate: {
      validator: async function(employeeID) {
        const User = mongoose.model('User');
        const user = await User.findOne({ employeeID });
        return !!user;
      },
      message: 'Employee ID does not exist in the system'
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Pre-save middleware to ensure ID is generated and update updatedAt
announcementSchema.pre('save', async function(next) {
  try {
    // Always generate a new ID if it doesn't exist
    if (!this.id) {
      this.id = await generateAnnouncementId();
    }
    this.updatedAt = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

// Add a post-save validation to ensure ID exists
announcementSchema.post('save', function(error, doc, next) {
  if (!doc.id) {
    next(new Error('Failed to generate announcement ID'));
  } else {
    next();
  }
});

const Announcement = mongoose.model('Announcement', announcementSchema);

module.exports = Announcement; 
// server.js - Express API for Clash War Tracker

const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
let db;
const MONGODB_URI = process.env.MONGODB_URI;

MongoClient.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(client => {
    console.log('Connected to MongoDB Atlas');
    db = client.db('clash_tracker');
  })
  .catch(error => {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  });

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get outbound IP address (for Clash API token setup)
app.get('/api/myip', (req, res) => {
  const https = require('https');
  
  https.get('https://api.ipify.org?format=json', (response) => {
    let data = '';
    
    response.on('data', (chunk) => {
      data += chunk;
    });
    
    response.on('end', () => {
      try {
        const ipData = JSON.parse(data);
        res.json({
          outboundIP: ipData.ip,
          message: 'Use this IP address for your Clash of Clans API token',
          timestamp: new Date().toISOString(),
          instructions: 'Go to https://developer.clashofclans.com and create a token with this IP'
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to parse IP data' });
      }
    });
  }).on('error', (error) => {
    res.status(500).json({ error: error.message });
  });
});

// Get current/latest war
app.get('/api/wars/current', async (req, res) => {
  try {
    const war = await db.collection('wars')
      .findOne({}, { sort: { preparationStartTime: -1 } });
    
    if (!war) {
      return res.status(404).json({ message: 'No war data found' });
    }
    
    res.json(war);
  } catch (error) {
    console.error('Error fetching current war:', error);
    res.status(500).json({ error: 'Failed to fetch war data' });
  }
});

// Get war statistics for last N wars
app.get('/api/wars/stats', async (req, res) => {
  try {
    const count = parseInt(req.query.count) || 10;
    const warType = req.query.warType; // optional filter: 'regular' or 'cwl'
    
    // Build query
    const query = { finalized: true };
    if (warType) {
      query.warType = warType;
    }
    
    // Fetch last N finalized wars
    const wars = await db.collection('wars')
      .find(query)
      .sort({ endTime: -1 })
      .limit(count)
      .toArray();
    
    if (wars.length === 0) {
      return res.json({
        message: 'No finalized wars found',
        stats: null
      });
    }
    
    // Calculate member statistics
    const memberStats = {};
    
    wars.forEach(war => {
      war.participants.forEach(participant => {
        if (!memberStats[participant.tag]) {
          memberStats[participant.tag] = {
            tag: participant.tag,
            name: participant.name,
            warsParticipated: 0,
            totalAttacksUsed: 0,
            totalAttacksAvailable: 0,
            totalStars: 0,
            totalDestruction: 0,
            totalAttacksMade: 0,
            attacks: []
          };
        }
        
        const stats = memberStats[participant.tag];
        stats.warsParticipated++;
        stats.totalAttacksUsed += participant.attacksUsed;
        stats.totalAttacksAvailable += participant.attacksAvailable;
        
        // Process each attack for stars and destruction
        participant.attacks.forEach(attack => {
          stats.totalStars += attack.stars || 0;
          stats.totalDestruction += attack.destructionPercentage || 0;
          stats.totalAttacksMade++;
          stats.attacks.push(attack);
        });
      });
    });
    
    // Calculate averages and percentages
    const memberStatsArray = Object.values(memberStats).map(stats => ({
      tag: stats.tag,
      name: stats.name,
      warsParticipated: stats.warsParticipated,
      attackUsedPercentage: ((stats.totalAttacksUsed / stats.totalAttacksAvailable) * 100).toFixed(2),
      averageStarsPerAttack: stats.totalAttacksMade > 0 
        ? (stats.totalStars / stats.totalAttacksMade).toFixed(2) 
        : 0,
      averageDestructionPercentage: stats.totalAttacksMade > 0 
        ? (stats.totalDestruction / stats.totalAttacksMade).toFixed(2) 
        : 0,
      totalAttacksUsed: stats.totalAttacksUsed,
      totalAttacksAvailable: stats.totalAttacksAvailable
    }));
    
    // Sort by attack usage percentage
    memberStatsArray.sort((a, b) => 
      parseFloat(b.attackUsedPercentage) - parseFloat(a.attackUsedPercentage)
    );
    
    // Calculate war-level trends
    const warTrends = wars.reverse().map(war => ({
      warId: war.warId,
      endTime: war.endTime,
      clanScore: war.clanScore,
      opponentScore: war.opponentScore,
      attackUsagePercentage: war.statistics.attackUsagePercentage,
      membersWithFullAttacks: war.statistics.membersWithFullAttacks,
      totalMembers: war.statistics.totalMembers,
      won: war.clanScore > war.opponentScore
    }));
    
    // Calculate attack usage distribution
    const usageRanges = {
      '0-25%': 0,
      '26-50%': 0,
      '51-75%': 0,
      '76-99%': 0,
      '100%': 0
    };
    
    memberStatsArray.forEach(member => {
      const usage = parseFloat(member.attackUsedPercentage);
      if (usage === 100) usageRanges['100%']++;
      else if (usage >= 76) usageRanges['76-99%']++;
      else if (usage >= 51) usageRanges['51-75%']++;
      else if (usage >= 26) usageRanges['26-50%']++;
      else usageRanges['0-25%']++;
    });
    
    res.json({
      summary: {
        totalWarsAnalyzed: wars.length,
        totalMembers: memberStatsArray.length,
        dateRange: {
          from: wars[0].endTime,
          to: wars[wars.length - 1].endTime
        }
      },
      memberStats: memberStatsArray,
      warTrends,
      attackUsageDistribution: usageRanges
    });
    
  } catch (error) {
    console.error('Error fetching war stats:', error);
    res.status(500).json({ error: 'Failed to fetch war statistics' });
  }
});

// Get specific member's war history
app.get('/api/members/:tag/history', async (req, res) => {
  try {
    const memberTag = decodeURIComponent(req.params.tag);
    const count = parseInt(req.query.count) || 10;
    
    const wars = await db.collection('wars')
      .find({ 
        finalized: true,
        'participants.tag': memberTag 
      })
      .sort({ endTime: -1 })
      .limit(count)
      .toArray();
    
    const memberHistory = wars.map(war => {
      const participant = war.participants.find(p => p.tag === memberTag);
      return {
        warId: war.warId,
        endTime: war.endTime,
        warType: war.warType,
        teamSize: war.teamSize,
        clanScore: war.clanScore,
        opponentScore: war.opponentScore,
        won: war.clanScore > war.opponentScore,
        memberData: participant
      };
    });
    
    res.json({
      memberTag,
      memberName: memberHistory[0]?.memberData?.name || 'Unknown',
      warsFound: memberHistory.length,
      history: memberHistory
    });
    
  } catch (error) {
    console.error('Error fetching member history:', error);
    res.status(500).json({ error: 'Failed to fetch member history' });
  }
});

// Get all wars (with pagination)
app.get('/api/wars', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    const wars = await db.collection('wars')
      .find({ finalized: true })
      .sort({ endTime: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    
    const totalWars = await db.collection('wars')
      .countDocuments({ finalized: true });
    
    res.json({
      wars,
      pagination: {
        page,
        limit,
        totalWars,
        totalPages: Math.ceil(totalWars / limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching wars:', error);
    res.status(500).json({ error: 'Failed to fetch wars' });
  }
});

// Get war by ID
app.get('/api/wars/:warId', async (req, res) => {
  try {
    const warId = req.params.warId;
    
    const war = await db.collection('wars').findOne({ warId });
    
    if (!war) {
      return res.status(404).json({ message: 'War not found' });
    }
    
    res.json(war);
  } catch (error) {
    console.error('Error fetching war:', error);
    res.status(500).json({ error: 'Failed to fetch war' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
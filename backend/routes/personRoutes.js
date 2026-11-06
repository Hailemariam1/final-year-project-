const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sendEmail = require('../utils/sendEmail');
const store = require('../services/firebaseStore');

const DEFAULT_AI_SERVICE_URL = 'https://final-year-project-0joz.onrender.com';
const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || DEFAULT_AI_SERVICE_URL).replace(/\/+$|^\s+|\s+$/g, '');

// Duplicate detection thresholds
const DUPLICATE_HIGH = 0.92; // auto-block
const DUPLICATE_REVIEW = 0.85; // flag for human review
const DUPLICATE_PROBABLE = 0.80; // probable match to show

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5000000 },
  fileFilter: function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.jfif'];
    const allowedMime = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/bmp',
      'image/x-ms-bmp',
      'image/pjpeg'
    ];

    if (allowedMime.includes((file.mimetype || '').toLowerCase()) || allowedExt.includes(ext)) {
      return cb(null, true);
    }

    return cb(new Error('Unsupported image format. Use JPG, PNG, WEBP, BMP, or JFIF.'));
  }
});

function handleImageUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ msg: err.message || 'Invalid image upload.' });
    }
    return next();
  });
}

function handleReportUploads(req, res, next) {
  // Accept both the person image and a national ID image for verification
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'nationalId', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) {
      return res.status(400).json({ msg: err.message || 'Invalid upload.' });
    }
    return next();
  });
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(vecA.length, vecB.length); i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function validateHumanFaceStrict(imageFile) {
  if (!AI_SERVICE_URL) {
    return {
      ok: false,
      status: 503,
      msg: 'AI face verification service is not configured. Image submission is temporarily unavailable.'
    };
  }

  try {
    const formData = new FormData();
    formData.append('image', imageFile.buffer, {
      filename: imageFile.originalname || `image${path.extname(imageFile.originalname || '.jpg')}`,
      contentType: imageFile.mimetype
    });

    const aiResponse = await axios.post(`${AI_SERVICE_URL}/validate-face`, formData, {
      headers: { ...formData.getHeaders() },
      timeout: 60000
    });

    const result = aiResponse?.data || {};
    if (!result.is_human_face) {
      return {
        ok: false,
        status: 400,
        msg: result.reason || 'Uploaded image was rejected. A clear human face is required.',
        ai: {
          is_human_face: false,
          confidence: Number(result.confidence || 0),
          faces_detected: Number(result.faces_detected || 0),
          detector: result.detector || 'unknown'
        }
      };
    }

    return {
      ok: true,
      ai: {
        is_human_face: true,
        confidence: Number(result.confidence || 0),
        faces_detected: Number(result.faces_detected || 0),
        detector: result.detector || 'unknown'
      }
    };
  } catch (err) {
    // Try a local fallback (developer may run ai-service locally on port 5001)
    try {
      const fallbackForm = new FormData();
      fallbackForm.append('image', imageFile.buffer, {
        filename: imageFile.originalname || `image${path.extname(imageFile.originalname || '.jpg')}`,
        contentType: imageFile.mimetype
      });
      const fallbackResp = await axios.post('http://127.0.0.1:5001/validate-face', fallbackForm, {
        headers: { ...fallbackForm.getHeaders() },
        timeout: 60000
      });
      const fallbackResult = fallbackResp?.data || {};
      if (!fallbackResult.is_human_face) {
        return {
          ok: false,
          status: 400,
          msg: fallbackResult.reason || 'Uploaded image was rejected by fallback AI service.',
          ai: {
            is_human_face: false,
            confidence: Number(fallbackResult.confidence || 0),
            faces_detected: Number(fallbackResult.faces_detected || 0),
            detector: fallbackResult.detector || 'fallback'
          }
        };
      }

      return {
        ok: true,
        ai: {
          is_human_face: true,
          confidence: Number(fallbackResult.confidence || 0),
          faces_detected: Number(fallbackResult.faces_detected || 0),
          detector: fallbackResult.detector || 'fallback'
        }
      };
    } catch (err2) {
      return {
        ok: false,
        status: 503,
        msg: 'AI verification service is unavailable. Please try again shortly.',
        error: err?.message || err2?.message || 'AI request failed'
      };
    }
  }
}

async function validateIdImage(idFile) {
  if (!AI_SERVICE_URL) {
    return {
      ok: false,
      status: 503,
      msg: 'AI ID verification service is not configured.'
    };
  }

  try {
    const formData = new FormData();
    formData.append('image', idFile.buffer, {
      filename: idFile.originalname || `id${path.extname(idFile.originalname || '.jpg')}`,
      contentType: idFile.mimetype
    });

    const aiResponse = await axios.post(`${AI_SERVICE_URL}/validate-id`, formData, {
      headers: { ...formData.getHeaders() },
      timeout: 60000
    });

    const result = aiResponse?.data || {};
    if (result.is_valid_id === false) {
      return {
        ok: false,
        status: 400,
        msg: result.reason || 'Uploaded ID could not be validated as an official document.',
        ai: result
      };
    }

    return { ok: true, ai: result };
  } catch (err) {
    // Try local fallback to ai-service on port 5001
    try {
      const fallbackForm = new FormData();
      fallbackForm.append('image', idFile.buffer, {
        filename: idFile.originalname || `id${path.extname(idFile.originalname || '.jpg')}`,
        contentType: idFile.mimetype
      });
      const fallbackResp = await axios.post('http://127.0.0.1:5001/validate-id', fallbackForm, {
        headers: { ...fallbackForm.getHeaders() },
        timeout: 60000
      });
      const fallbackResult = fallbackResp?.data || {};
      if (fallbackResult.is_valid_id === false) {
        return {
          ok: false,
          status: 400,
          msg: fallbackResult.reason || 'Uploaded ID could not be validated by fallback AI service.',
          ai: fallbackResult
        };
      }
      return { ok: true, ai: fallbackResult };
    } catch (err2) {
      return {
        ok: false,
        status: 503,
        msg: 'AI ID verification service is unavailable. Please try again shortly.',
        error: err?.message || err2?.message || 'AI request failed'
      };
    }
  }
}

function normalizePerson(person, userMap = {}) {
  const mapped = { ...person };
  const reporter = userMap[person.reportedBy];
  if (reporter) {
    mapped.reportedBy = {
      _id: reporter._id,
      username: reporter.username,
      role: reporter.role,
      isVerified: reporter.isVerified,
      email: reporter.email || null,
      profilePhoto: reporter.profilePhoto || null,
      organizationName: reporter.organizationName || null
    };
  }
  return mapped;
}

function buildChangeHistoryEntry({ person, patch, actor, actorId, changeType }) {
  const oldValues = {};
  const newValues = {};

  Object.keys(patch || {}).forEach((key) => {
    const oldValue = person[key];
    const newValue = patch[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      oldValues[key] = oldValue;
      newValues[key] = newValue;
    }
  });

  if (!Object.keys(newValues).length) return null;

  return {
    changeType: changeType || 'edit',
    changedAt: new Date().toISOString(),
    changedBy: actorId,
    changedByName: actor?.username || 'Unknown User',
    changedByRole: actor?.role || 'unknown',
    changedByEmail: actor?.email || null,
    changedByProfilePhoto: actor?.profilePhoto || null,
    oldValues,
    newValues
  };
}

function normalizeUpdateRequest(request, userMap = {}, personMap = {}) {
  const requester = userMap[request.requestedBy];
  const reviewer = userMap[request.reviewedBy];
  const person = personMap[request.personId];

  return {
    ...request,
    requestedByUser: requester
      ? {
          _id: requester._id,
          username: requester.username,
          role: requester.role,
          email: requester.email || null,
          profilePhoto: requester.profilePhoto || null,
          organizationName: requester.organizationName || null
        }
      : null,
    reviewedByUser: reviewer
      ? {
          _id: reviewer._id,
          username: reviewer.username,
          role: reviewer.role,
          email: reviewer.email || null,
          profilePhoto: reviewer.profilePhoto || null,
          organizationName: reviewer.organizationName || null
        }
      : null,
    person: person ? normalizePerson(person, userMap) : null
  };
}

async function logActivity(type, actor, target, details = {}) {
  return store.createActivityLog({
    type,
    actorId: actor?._id || null,
    actorName: actor?.username || 'Unknown User',
    actorRole: actor?.role || 'unknown',
    actorEmail: actor?.email || null,
    actorProfilePhoto: actor?.profilePhoto || null,
    target,
    details
  });
}

function applyFilters(people, query) {
  let result = [...people];
  if (query.status) result = result.filter((p) => p.status === query.status);
  if (query.name) result = result.filter((p) => (p.fullName || '').toLowerCase().includes(String(query.name).toLowerCase()));
  if (query.city) result = result.filter((p) => (p.city || '').toLowerCase().includes(String(query.city).toLowerCase()));
  if (query.gender) result = result.filter((p) => String(p.gender || '').toLowerCase() === String(query.gender).toLowerCase());
  if (query.region) result = result.filter((p) => String(p.region || '').toLowerCase().includes(String(query.region).toLowerCase()));

  if (query.minAge || query.maxAge) {
    const minAge = query.minAge ? Number(query.minAge) : -Infinity;
    const maxAge = query.maxAge ? Number(query.maxAge) : Infinity;
    result = result.filter((p) => Number(p.age || 0) >= minAge && Number(p.age || 0) <= maxAge);
  }

  if (query.date) {
    const date = new Date(query.date).getTime();
    result = result.filter((p) => new Date(p.lastSeenDate || 0).getTime() >= date);
  }

  const sortKey = query.sort;
  if (sortKey === 'oldest') result.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  else if (sortKey === 'alpha_asc') result.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
  else if (sortKey === 'alpha_desc') result.sort((a, b) => (b.fullName || '').localeCompare(a.fullName || ''));
  else if (sortKey === 'date_desc') result.sort((a, b) => new Date(b.lastSeenDate || 0) - new Date(a.lastSeenDate || 0));
  else result.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  return result;
}

async function generateFaceEmbeddingFromFile(file) {
  if (!AI_SERVICE_URL) {
    throw new Error('AI face verification service is not configured.');
  }

  const formData = new FormData();
  formData.append('image', file.buffer, {
    filename: file.originalname || `image${path.extname(file.originalname || '.jpg')}`,
    contentType: file.mimetype
  });

  const requestConfig = {
    headers: { ...formData.getHeaders() },
    timeout: 60000
  };

  try {
    const aiResponse = await axios.post(`${AI_SERVICE_URL}/generate-embedding`, formData, requestConfig);
    const embedding = aiResponse?.data?.embedding;
    if (!Array.isArray(embedding) || !embedding.length) {
      throw new Error('Failed to generate embedding for the uploaded image.');
    }
    return embedding;
  } catch (primaryError) {
    try {
      const fallbackResponse = await axios.post('http://127.0.0.1:5001/generate-embedding', formData, requestConfig);
      const fallbackEmbedding = fallbackResponse?.data?.embedding;
      if (!Array.isArray(fallbackEmbedding) || !fallbackEmbedding.length) {
        throw new Error('Fallback AI embedding service returned no embedding.');
      }
      return fallbackEmbedding;
    } catch (fallbackError) {
      throw new Error(primaryError?.message || fallbackError?.message || 'AI embedding generation failed.');
    }
  }
}

router.get('/notifications', auth(), async (req, res) => {
  try {
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unreadOnly || '').toLowerCase());
    const notifications = await store.listNotificationsByUser(req.user.id);
    return res.json(unreadOnly ? notifications.filter((n) => !n.isRead) : notifications);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/my-reports', auth(), async (req, res) => {
  try {
    const users = await store.listUsers();
    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));
    const people = await store.listPeople((p) => String(p.reportedBy) === String(req.user.id));
    people.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    return res.json(people.map((p) => normalizePerson(p, userMap)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.put('/notifications/:id/read', auth(), async (req, res) => {
  try {
    const notification = await store.getNotificationById(req.params.id);
    if (!notification) {
      return res.status(404).json({ msg: 'Notification not found' });
    }

    if (String(notification.user) !== String(req.user.id)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }

    const updated = await store.updateNotification(req.params.id, { isRead: true });
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/pending', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }
    const users = await store.listUsers();
    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));
    const people = await store.listPeople((p) => !p.isApproved);
    people.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    return res.json(people.map((p) => normalizePerson(p, userMap)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/police/all', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }

    const users = await store.listUsers();
    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));

    const people = await store.listPeople((p) => !req.query.status || p.status === req.query.status);
    people.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json(people.map((p) => normalizePerson(p, userMap)));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/with-mine', auth(), async (req, res) => {
  try {
    const users = await store.listUsers();
    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));

    let people = await store.listPeople((p) => p.isApproved === true || String(p.reportedBy) === String(req.user.id));
    people = applyFilters(people, req.query).map((p) => normalizePerson(p, userMap));
    return res.json(people);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const users = await store.listUsers();
    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));

    let people = await store.listPeople((p) => p.isApproved === true);
    people = applyFilters(people, req.query).map((p) => normalizePerson(p, userMap));
    return res.json(people);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/admin/approval-log', auth(['admin']), async (req, res) => {
  try {
    const users = await store.listUsers();
    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));
    const approvedPeople = await store.listPeople((p) => p.isApproved === true);

    approvedPeople.sort((a, b) => new Date(b.approvedAt || b.updatedAt || 0) - new Date(a.approvedAt || a.updatedAt || 0));

    const log = approvedPeople
      .filter((person) => person.approvedBy || person.reportedBy)
      .map((person) => {
        const explicitApprover = userMap[person.approvedBy];
        const reporterUser = userMap[person.reportedBy];
        const isPoliceAutoApproval = ['law_enforcement', 'admin'].includes(reporterUser?.role || '');

        const approvedBy = person.approvedBy || (isPoliceAutoApproval ? person.reportedBy : null);
        const approvedByName =
          person.approvedByName
          || explicitApprover?.username
          || (isPoliceAutoApproval ? reporterUser?.username : null)
          || null;
        const approvedByRole =
          person.approvedByRole
          || explicitApprover?.role
          || (isPoliceAutoApproval ? reporterUser?.role : null)
          || null;
        const approvalSource =
          person.approvalSource
          || (explicitApprover ? 'explicit-approver' : (isPoliceAutoApproval ? 'auto-approved-reporter' : 'legacy-record'));
        const approvedAt = person.approvedAt || (isPoliceAutoApproval ? person.createdAt : null) || person.updatedAt || person.createdAt || null;
        const approvedByEmail =
          person.approvedByEmail
          || explicitApprover?.email
          || (isPoliceAutoApproval ? reporterUser?.email : null)
          || null;
        const approvedByNameFinal =
          approvedByName
          || (approvedByEmail ? approvedByEmail.split('@')[0] : null)
          || null;
        const approvedByRoleFinal = approvedByRole || (approvalSource === 'legacy-record' ? 'unknown' : null);
        const approvedByUser = approvedByNameFinal
          ? {
              _id: approvedBy || null,
              username: approvedByNameFinal,
              role: approvedByRoleFinal || 'unknown',
              email: approvedByEmail,
              profilePhoto: explicitApprover?.profilePhoto || (isPoliceAutoApproval ? reporterUser?.profilePhoto : null) || null,
              source: approvalSource
            }
          : null;

        const caseDisplay = person.policeCaseNumber || person.officialVerificationRef || person._id || null;

        return {
          ...normalizePerson(person, userMap),
          caseDisplay,
          approvedBy,
          approvedByName: approvedByNameFinal,
          approvedByRole: approvedByRoleFinal,
          approvedAt,
          approvedByEmail,
          approvedByUser,
          approvalSource,
          changeHistory: Array.isArray(person.changeHistory)
            ? person.changeHistory.map((entry) => {
                const changedByUser = userMap[entry.changedBy];
                return {
                  ...entry,
                  changedByUser: changedByUser
                    ? {
                        _id: changedByUser._id,
                        username: changedByUser.username,
                        role: changedByUser.role,
                        email: changedByUser.email || null,
                        profilePhoto: changedByUser.profilePhoto || null
                      }
                    : null
                };
              })
            : []
        };
      });

    return res.json(log);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.post('/search/image', handleImageUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ msg: 'Please upload an image file.' });
    }

    const faceValidation = await validateHumanFaceStrict(req.file);
    if (!faceValidation.ok) {
      return res.status(faceValidation.status || 400).json({
        msg: faceValidation.msg,
        aiValidation: faceValidation.ai || null
      });
    }

    const requestedMin = Number(req.query.minSimilarity);
    const minSimilarity = Number.isFinite(requestedMin)
      ? Math.min(0.95, Math.max(0.7, requestedMin))
      : 0.82;

    const queryEmbedding = await generateFaceEmbeddingFromFile(req.file);

    const [users, people] = await Promise.all([
      store.listUsers(),
      store.listPeople((p) => p.status === 'Missing' && p.isApproved === true && Array.isArray(p.faceEmbeddings) && p.faceEmbeddings.length)
    ]);

    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));

    const rankedMatches = people
      .map((person) => ({
        person: normalizePerson(person, userMap),
        similarity: cosineSimilarity(queryEmbedding, person.faceEmbeddings || [])
      }))
      .filter((item) => Number.isFinite(item.similarity) && item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);

    const matches = rankedMatches.length
      ? [{
          ...rankedMatches[0].person,
          similarity: Number(rankedMatches[0].similarity.toFixed(4))
        }]
      : [];

    return res.json({
      minSimilarity,
      total: matches.length,
      matches
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: err.message || 'Image search failed.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const person = await store.getPersonById(req.params.id);
    if (!person) return res.status(404).json({ msg: 'Person not found' });
    return res.json(person);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.post('/', [auth(), handleReportUploads], async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.status(403).json({ msg: 'System admin accounts cannot submit person reports.' });
    }

    const {
      fullName,
      age,
      gender,
      description,
      lastSeenDate,
      lastSeenLocation,
      city,
      region,
      contactPhone,
      status,
      isAnonymous,
      officialVerificationRef,
      policeDistrict,
      policeCaseNumber,
      isPoliceReported,
      vehicleInformation,
      socialMediaAccounts,
      height,
      weight,
      eyeColor,
      hairColor,
      race,
      complexion,
      distinguishingMarks,
      classification
    } = req.body;

    const reporter = await store.getUserById(req.user.id);
    const isApproved = !!(reporter && ['law_enforcement', 'admin'].includes(reporter.role));
    const hasOfficialReference = !!String(officialVerificationRef || policeCaseNumber || '').trim();

    if (!hasOfficialReference) {
      return res.status(400).json({ msg: 'A report ID or official verification reference is required.' });
    }

    const payload = {
      fullName,
      age,
      gender,
      description,
      lastSeenDate,
      lastSeenLocation,
      city,
      region,
      contactPhone,
      status,
      height,
      weight,
      eyeColor,
      hairColor,
      race,
      complexion,
      distinguishingMarks,
      classification,
      reportedBy: req.user.id,
      isAnonymous: isAnonymous === 'true' || isAnonymous === true,
      isApproved,
      officialVerificationRef: String(officialVerificationRef || '').trim(),
      policeDistrict,
      policeCaseNumber,
      isPoliceReported: hasOfficialReference || isPoliceReported === 'true' || isPoliceReported === true,
      vehicleInformation,
      socialMediaAccounts,
      images: [],
      faceEmbeddings: []
    };

    // Police/admin submissions are auto-approved and should appear in approval logs with actor/time.
    if (isApproved) {
      payload.approvedAt = new Date().toISOString();
      payload.approvedBy = req.user.id;
      payload.approvedByName = reporter?.username || 'Police Admin';
      payload.approvedByRole = reporter?.role || req.user.role;
      payload.approvedByEmail = reporter?.email || null;
      payload.approvalSource = 'auto-approved-reporter';
    }

    // For regular reporters require a national ID validation step
    const imageFile = req.files && req.files.image && req.files.image[0];
    const idFile = req.files && req.files.nationalId && req.files.nationalId[0];

    if (!isApproved) {
      if (!idFile) {
        return res.status(400).json({ msg: 'National ID image is required for validation before submitting a report.' });
      }

      const idValidation = await validateIdImage(idFile);
      if (!idValidation.ok) {
        return res.status(idValidation.status || 400).json({ msg: idValidation.msg, aiValidation: idValidation.ai || null });
      }
    }

    if (imageFile) {
      const faceValidation = await validateHumanFaceStrict(imageFile);
      if (!faceValidation.ok) {
        return res.status(faceValidation.status || 400).json({
          msg: faceValidation.msg,
          aiValidation: faceValidation.ai || null
        });
      }

      let flaggedDuplicateInfo = null;

      try {
        const formData = new FormData();
        formData.append('image', imageFile.buffer, {
          filename: imageFile.originalname || `image${path.extname(imageFile.originalname || '.jpg')}`,
          contentType: imageFile.mimetype
        });

        const aiResponse = await axios.post(`${AI_SERVICE_URL}/generate-embedding`, formData, {
          headers: { ...formData.getHeaders() }
        });

        if (Array.isArray(aiResponse.data.embedding)) {
          // normalize embeddings (defensive)
          const rawEmbedding = aiResponse.data.embedding;
          const norm = Math.sqrt(rawEmbedding.reduce((s, v) => s + (v * v), 0)) || 1;
          payload.faceEmbeddings = rawEmbedding.map((v) => v / norm);

          // Prefer fast index search via AI service if available
          try {
            const searchResp = await axios.post(`${AI_SERVICE_URL}/index-search`, { embedding: payload.faceEmbeddings, k: 6 }, { timeout: 10000 });
            const results = (searchResp.data && searchResp.data.results) || [];
            for (const r of results) {
              const sim = Number(r.similarity || 0);
              if (sim >= DUPLICATE_HIGH) {
                flaggedDuplicateInfo = {
                  matchedPersonId: r.id,
                  similarity: sim,
                  scope: 'registry'
                };
                break;
              }
            }
          } catch (e) {
            // fallback to linear DB scan if index/search fails
            const allPeople = await store.listPeople((p) => Array.isArray(p.faceEmbeddings) && p.faceEmbeddings.length);
            for (const other of allPeople) {
              const otherNorm = Math.sqrt(other.faceEmbeddings.reduce((s, v) => s + (v * v), 0)) || 1;
              const otherEmb = other.faceEmbeddings.map((v) => v / otherNorm);
              const sim = cosineSimilarity(payload.faceEmbeddings, otherEmb);
              if (sim >= DUPLICATE_HIGH) {
                flaggedDuplicateInfo = {
                  matchedPersonId: other._id,
                  similarity: sim,
                  scope: 'registry'
                };
                break;
              }
            }
          }

          if (status === 'Missing') {
            const existingMissing = await store.listPeople(
              (p) => p.status === 'Missing' && Array.isArray(p.faceEmbeddings) && p.faceEmbeddings.length
            );
            for (const other of existingMissing) {
              const otherNorm = Math.sqrt(other.faceEmbeddings.reduce((s, v) => s + (v * v), 0)) || 1;
              const otherEmb = other.faceEmbeddings.map((v) => v / otherNorm);
              const sim = cosineSimilarity(payload.faceEmbeddings, otherEmb);
              if (sim >= DUPLICATE_HIGH) {
                flaggedDuplicateInfo = {
                  matchedPersonId: other._id,
                  similarity: sim,
                  scope: String(other.reportedBy) === String(req.user.id) ? 'self-report' : 'existing-missing'
                };
                break;
              }

              if (sim >= DUPLICATE_REVIEW) {
                // prepare flag info to persist after saving
                flaggedDuplicateInfo = { matchedPersonId: other._id, similarity: sim };
                break;
              }
            }

            // attach any flag info to payload so it can be persisted later
            if (flaggedDuplicateInfo) {
              payload.flaggedDuplicate = true;
              payload.flaggedDuplicateInfo = flaggedDuplicateInfo;
            }
          }
        }
      } catch (aiError) {
        console.error('AI Service Error:', aiError.message);
      }

      const image = await store.createFile({
        originalName: imageFile.originalname,
        contentType: imageFile.mimetype,
        size: imageFile.size,
        dataBuffer: imageFile.buffer,
        uploadedBy: req.user.id,
        purpose: 'person-image'
      });

      payload.images.push({ url: `api/files/${image._id}` });
    }

    const newPerson = await store.createPerson(payload);

    // After saving, add embedding to AI service index for faster future searches
    try {
      if (Array.isArray(newPerson.faceEmbeddings) && newPerson.faceEmbeddings.length) {
        await axios.post(`${AI_SERVICE_URL}/index-add`, { id: newPerson._id, embedding: newPerson.faceEmbeddings }, { timeout: 8000 });
      }
    } catch (e) {
      console.error('Index add failed:', e.message || e);
    }

    await logActivity(isApproved ? 'police-report-created' : 'user-report-created', reporter, { personId: newPerson._id }, {
      caseName: newPerson.fullName || null,
      status: newPerson.status || null,
      isApproved: !!newPerson.isApproved
    });

    const matches = [];
    if (Array.isArray(newPerson.faceEmbeddings) && newPerson.faceEmbeddings.length) {
      const others = await store.listPeople(
        (p) => p._id !== newPerson._id && Array.isArray(p.faceEmbeddings) && p.faceEmbeddings.length
      );

      for (const other of others) {
        const otherNorm = Math.sqrt(other.faceEmbeddings.reduce((s, v) => s + (v * v), 0)) || 1;
        const otherEmb = other.faceEmbeddings.map((v) => v / otherNorm);
        const similarity = cosineSimilarity(newPerson.faceEmbeddings, otherEmb);
        if (similarity >= DUPLICATE_PROBABLE) {
          matches.push({ person: other, similarity });

          if (newPerson.status === 'Found' && other.status === 'Missing') {
            const originalReporter = await store.getUserById(other.reportedBy);
            if (originalReporter) {
              try {
                await sendEmail({
                  email: originalReporter.email,
                  subject: 'Potential Match Found!',
                  message: `Good news! A match has been found for (${other.fullName}). Go to your dashboard for details.`
                });
              } catch (e) {
                console.error(e);
              }

              await store.createNotification({
                user: originalReporter._id,
                message: `A sighting matched your missing report for ${other.fullName} (Similarity: ${(similarity * 100).toFixed(1)}%).`,
                relatedPersonId: newPerson._id
              });
            }
          }
        }
      }
    }

    return res.json({ msg: 'Report submitted', person: newPerson, potentialMatches: matches });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error', error: err.message });
  }
});

router.put('/:id', auth(), async (req, res) => {
  try {
    const person = await store.getPersonById(req.params.id);
    if (!person) return res.status(404).json({ msg: 'Record not found' });

    const isPolice = ['law_enforcement', 'admin'].includes(req.user.role);
    if (String(person.reportedBy) !== String(req.user.id) && !isPolice) {
      return res.status(401).json({ msg: 'Not authorized to edit this report' });
    }

    const patch = {};
    const allowed = [
      'status',
      'description',
      'fullName',
      'age',
      'city',
      'classification',
      'policeDistrict',
      'policeCaseNumber',
      'weight',
      'height',
      'hairColor',
      'eyeColor',
      'distinguishingMarks'
    ];

    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    const actor = await store.getUserById(req.user.id);

    if (!Object.keys(patch).length) {
      return res.status(400).json({ msg: 'No valid fields provided for update.' });
    }

    if (!isPolice) {
      const existingPending = await store.listPersonUpdateRequests(
        (r) => String(r.personId) === String(person._id)
          && String(r.requestedBy) === String(req.user.id)
          && r.status === 'pending'
      );

      if (existingPending.length) {
        return res.status(409).json({ msg: 'You already have a pending update request for this case.' });
      }

      const request = await store.createPersonUpdateRequest({
        personId: person._id,
        requestedBy: req.user.id,
        requestedByRole: actor?.role || req.user.role,
        status: 'pending',
        patch,
        reason: String(req.body.reason || '').trim() || null
      });

      const reviewers = await store.listUsers((u) => ['law_enforcement', 'admin'].includes(u.role));
      await Promise.all(
        reviewers.map((u) => store.createNotification({
          user: u._id,
          message: `${actor?.username || 'A user'} requested a case update for ${person.fullName || person._id}.`,
          relatedPersonId: person._id
        }))
      );

      await logActivity('user-case-update-requested', actor, { personId: person._id, requestId: request._id }, {
        patch,
        caseName: person.fullName || null
      });

      return res.status(202).json({
        msg: 'Update request submitted. Police admin will review and apply changes after approval.',
        request
      });
    }

    const entry = buildChangeHistoryEntry({
      person,
      patch,
      actor,
      actorId: req.user.id,
      changeType: 'edit-report'
    });

    if (entry) {
      patch.changeHistory = [...(Array.isArray(person.changeHistory) ? person.changeHistory : []), entry].slice(-40);
    }

    const updated = await store.updatePerson(req.params.id, patch);

    if (String(person.reportedBy) !== String(req.user.id)) {
      await store.createNotification({
        user: person.reportedBy,
        message: `${actor?.username || 'Police admin'} applied updates to your case (${person.fullName || person._id}).`,
        relatedPersonId: person._id
      });
    }

    await logActivity('police-case-updated', actor, { personId: person._id }, {
      patch,
      caseName: person.fullName || null
    });

    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

// Admin endpoint: list flagged potential duplicates for review
router.get('/flagged-duplicates', auth(), async (req, res) => {
  try {
    // only admin or law enforcement can review flags
    if (!['admin', 'law_enforcement'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Not authorized' });
    }

    const flagged = await store.listPeople((p) => p.flaggedDuplicate === true);
    return res.json({ total: flagged.length, items: flagged });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

// Admin endpoint: resolve a flagged duplicate (confirm or dismiss)
router.post('/:id/flagged-resolve', auth(), async (req, res) => {
  try {
    if (!['admin', 'law_enforcement'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Not authorized' });
    }

    const person = await store.getPersonById(req.params.id);
    if (!person) return res.status(404).json({ msg: 'Not found' });

    const action = String(req.body.action || '').toLowerCase();
    const reviewer = await store.getUserById(req.user.id);

    const patch = {
      flaggedDuplicate: false,
      flaggedResolvedAt: new Date().toISOString(),
      flaggedResolvedBy: req.user.id,
      flaggedResolvedByName: reviewer?.username || null,
      flaggedResolvedByRole: reviewer?.role || req.user.role
    };

    if (action === 'confirm' || action === 'confirm_duplicate' || action === 'confirm-duplicate') {
      patch.duplicateConfirmed = true;
      if (req.body.matchedPersonId) patch.duplicateMatchedPersonId = req.body.matchedPersonId;
      await logActivity('flagged-duplicate-confirmed', reviewer, { personId: person._id }, { matchedPersonId: req.body.matchedPersonId || null });
    } else {
      patch.duplicateConfirmed = false;
      await logActivity('flagged-duplicate-dismissed', reviewer, { personId: person._id }, {});
    }

    const updated = await store.updatePerson(req.params.id, patch);
    return res.json({ ok: true, updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

// Admin endpoint: merge a flagged person into an existing person record
router.post('/:id/merge', auth(), async (req, res) => {
  try {
    if (!['admin', 'law_enforcement'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Not authorized' });
    }

    const person = await store.getPersonById(req.params.id);
    if (!person) return res.status(404).json({ msg: 'Not found' });

    const matchedId = String(req.body.matchedPersonId || '').trim();
    if (!matchedId) return res.status(400).json({ msg: 'matchedPersonId is required' });

    const matched = await store.getPersonById(matchedId);
    if (!matched) return res.status(404).json({ msg: 'Matched person not found' });

    const reviewer = await store.getUserById(req.user.id);

    // fields to merge: prefer existing matched values, fill empty from person
    const mergeFields = ['fullName','description','city','region','lastSeenDate','contactPhone','status','classification','age','gender','height','weight','eyeColor','hairColor','race','distinguishingMarks','socialMediaAccounts','vehicleInformation'];
    const patch = {};
    mergeFields.forEach((f) => {
      if ((!matched[f] || matched[f] === '') && person[f]) patch[f] = person[f];
    });

    // merge images
    const matchedImages = Array.isArray(matched.images) ? matched.images.slice() : [];
    const personImages = Array.isArray(person.images) ? person.images.slice() : [];
    const existing = new Set(matchedImages.map((i) => i.url));
    const additions = personImages.filter((i) => !existing.has(i.url));
    patch.images = [...matchedImages, ...additions];

    // merge changeHistory
    patch.changeHistory = [...(Array.isArray(matched.changeHistory) ? matched.changeHistory : []), ...(Array.isArray(person.changeHistory) ? person.changeHistory : [])].slice(-100);

    // merged metadata
    patch.mergedFrom = [...(Array.isArray(matched.mergedFrom) ? matched.mergedFrom : []), person._id];
    patch.mergedAt = new Date().toISOString();
    patch.mergedBy = req.user.id;
    patch.mergedByName = reviewer?.username || null;

    const updatedMatched = await store.updatePerson(matchedId, patch);

    // mark original as merged
    const originalPatch = {
      mergedInto: matchedId,
      mergedAt: new Date().toISOString(),
      mergedBy: req.user.id,
      flaggedDuplicate: false
    };
    const updatedOriginal = await store.updatePerson(person._id, originalPatch);

    // update AI index for matched person if embeddings available
    try {
      if (Array.isArray(updatedMatched.faceEmbeddings) && updatedMatched.faceEmbeddings.length) {
        await axios.post(`${AI_SERVICE_URL}/index-add`, { id: matchedId, embedding: updatedMatched.faceEmbeddings }, { timeout: 8000 });
      }
    } catch (e) {
      console.error('Index update after merge failed:', e.message || e);
    }

    await logActivity('records-merged', reviewer, { fromPersonId: person._id, toPersonId: matchedId }, {});

    return res.json({ ok: true, mergedInto: updatedMatched, original: updatedOriginal });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.put('/:id/approve', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }
    const person = await store.getPersonById(req.params.id);
    if (!person) return res.status(404).json({ msg: 'Not found' });
    const approver = await store.getUserById(req.user.id);
    const approvalPatch = {
      isApproved: true,
      approvedAt: new Date().toISOString(),
      approvedBy: req.user.id,
      approvedByName: approver?.username || 'Police Admin',
      approvedByRole: approver?.role || req.user.role,
      approvedByEmail: approver?.email || null,
      approvalSource: 'explicit-approver'
    };
    const approvalHistory = buildChangeHistoryEntry({
      person,
      patch: { isApproved: true },
      actor: approver,
      actorId: req.user.id,
      changeType: 'approve-report'
    });
    if (approvalHistory) {
      approvalPatch.changeHistory = [...(Array.isArray(person.changeHistory) ? person.changeHistory : []), approvalHistory].slice(-40);
    }

    const updated = await store.updatePerson(req.params.id, approvalPatch);
    await logActivity('case-approved', approver, { personId: person._id }, {
      caseName: person.fullName || null,
      source: 'explicit-approver',
      approvedByRole: 'police admin',
      oldFile: {
        isApproved: !!person.isApproved
      },
      updatedFile: {
        isApproved: true
      }
    });
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.put('/:id/status', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }
    const person = await store.getPersonById(req.params.id);
    if (!person) return res.status(404).json({ msg: 'Not found' });
    const actor = await store.getUserById(req.user.id);
    const statusPatch = { status: req.body.status };
    const statusHistory = buildChangeHistoryEntry({
      person,
      patch: statusPatch,
      actor,
      actorId: req.user.id,
      changeType: 'status-update'
    });
    if (statusHistory) {
      statusPatch.changeHistory = [...(Array.isArray(person.changeHistory) ? person.changeHistory : []), statusHistory].slice(-40);
    }
    const updated = await store.updatePerson(req.params.id, statusPatch);
    await logActivity('case-status-updated', actor, { personId: person._id }, {
      oldStatus: person.status,
      newStatus: req.body.status,
      caseName: person.fullName || null
    });
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/update-requests/pending', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }

    const [users, people, requests] = await Promise.all([
      store.listUsers(),
      store.listPeople(),
      store.listPersonUpdateRequests((r) => r.status === 'pending')
    ]);

    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));
    const personMap = Object.fromEntries(people.map((p) => [p._id, p]));

    const result = requests
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map((r) => normalizeUpdateRequest(r, userMap, personMap));

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/update-requests/mine', auth(), async (req, res) => {
  try {
    const [users, people, requests] = await Promise.all([
      store.listUsers(),
      store.listPeople(),
      store.listPersonUpdateRequests((r) => String(r.requestedBy) === String(req.user.id))
    ]);

    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));
    const personMap = Object.fromEntries(people.map((p) => [p._id, p]));

    const result = requests
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map((r) => normalizeUpdateRequest(r, userMap, personMap));

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.put('/update-requests/:requestId/approve', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }

    const request = await store.getPersonUpdateRequestById(req.params.requestId);
    if (!request) return res.status(404).json({ msg: 'Update request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ msg: 'This update request has already been reviewed.' });
    }

    const person = await store.getPersonById(request.personId);
    if (!person) return res.status(404).json({ msg: 'Case not found' });

    const reviewer = await store.getUserById(req.user.id);
    const patch = request.patch || {};

    const entry = buildChangeHistoryEntry({
      person,
      patch,
      actor: reviewer,
      actorId: req.user.id,
      changeType: 'user-update-approved'
    });

    const personPatch = { ...patch };
    if (entry) {
      personPatch.changeHistory = [...(Array.isArray(person.changeHistory) ? person.changeHistory : []), entry].slice(-40);
    }

    const updatedPerson = await store.updatePerson(person._id, personPatch);

    const reviewedRequest = await store.updatePersonUpdateRequest(request._id, {
      status: 'approved',
      reviewedBy: req.user.id,
      reviewedAt: new Date().toISOString(),
      reviewReason: String(req.body.reason || '').trim() || null,
      appliedPatch: patch
    });

    await store.createNotification({
      user: request.requestedBy,
      message: `Your requested update for ${person.fullName || person._id} was approved and applied by ${reviewer?.username || 'Police admin'}.`,
      relatedPersonId: person._id
    });

    await logActivity('user-update-approved', reviewer, { personId: person._id, requestId: request._id }, {
      patch,
      requestedBy: request.requestedBy,
      caseName: person.fullName || null
    });

    return res.json({ msg: 'Update request approved and applied.', request: reviewedRequest, person: updatedPerson });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.put('/update-requests/:requestId/reject', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }

    const request = await store.getPersonUpdateRequestById(req.params.requestId);
    if (!request) return res.status(404).json({ msg: 'Update request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ msg: 'This update request has already been reviewed.' });
    }

    const reviewer = await store.getUserById(req.user.id);
    const person = await store.getPersonById(request.personId);

    const reviewedRequest = await store.updatePersonUpdateRequest(request._id, {
      status: 'rejected',
      reviewedBy: req.user.id,
      reviewedAt: new Date().toISOString(),
      reviewReason: String(req.body.reason || '').trim() || null
    });

    await store.createNotification({
      user: request.requestedBy,
      message: `Your requested update for ${person?.fullName || request.personId} was rejected. ${reviewedRequest.reviewReason ? `Reason: ${reviewedRequest.reviewReason}` : ''}`.trim(),
      relatedPersonId: request.personId
    });

    await logActivity('user-update-rejected', reviewer, { personId: request.personId, requestId: request._id }, {
      patch: request.patch || {},
      requestedBy: request.requestedBy,
      reason: reviewedRequest.reviewReason || null,
      caseName: person?.fullName || null
    });

    return res.json({ msg: 'Update request rejected.', request: reviewedRequest });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/admin/activity-log', auth(['admin']), async (req, res) => {
  try {
    const [users, activities] = await Promise.all([
      store.listUsers(),
      store.listActivityLogs()
    ]);

    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));

    const enriched = activities
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map((item) => {
        const actor = userMap[item.actorId];
        return {
          ...item,
          actor: actor
            ? {
                _id: actor._id,
                username: actor.username,
                role: actor.role,
                email: actor.email || null,
                profilePhoto: actor.profilePhoto || null,
                organizationName: actor.organizationName || null
              }
            : {
                _id: item.actorId || null,
                username: item.actorName || 'Unknown User',
                role: item.actorRole || 'unknown',
                email: item.actorEmail || null,
                profilePhoto: item.actorProfilePhoto || null,
                organizationName: null
              }
        };
      });

    return res.json(enriched);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/police/activity-log', auth(), async (req, res) => {
  try {
    if (!['law_enforcement', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ msg: 'Access Denied' });
    }

    const allowedTypes = new Set([
      'user-case-update-requested',
      'user-update-approved',
      'user-update-rejected',
      'case-comment-added',
      'case-tip-added',
      'police-case-updated',
      'case-status-updated'
    ]);

    const [users, activities] = await Promise.all([
      store.listUsers(),
      store.listActivityLogs((item) => allowedTypes.has(item.type))
    ]);

    const userMap = Object.fromEntries(users.map((u) => [u._id, u]));

    const enriched = activities
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 200)
      .map((item) => {
        const actor = userMap[item.actorId];
        return {
          ...item,
          actor: actor
            ? {
                _id: actor._id,
                username: actor.username,
                role: actor.role,
                email: actor.email || null,
                profilePhoto: actor.profilePhoto || null,
                organizationName: actor.organizationName || null
              }
            : {
                _id: item.actorId || null,
                username: item.actorName || 'Unknown User',
                role: item.actorRole || 'unknown',
                email: item.actorEmail || null,
                profilePhoto: item.actorProfilePhoto || null,
                organizationName: null
              }
        };
      });

    return res.json(enriched);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const auth = require('../middleware/auth');
const sendEmail = require('../utils/sendEmail');
const store = require('../services/firebaseStore');
const admin = require('firebase-admin');

const SYSTEM_ADMIN_EMAIL = 'habtetadilo@gmail.com';
const SYSTEM_ADMIN_PASSWORD = 'LaybreryA@2hailehshssbvs';

function getRedirectPath(role) {
  if (role === 'admin') return '/system_admin/index.html';
  if (role === 'law_enforcement') return '/police_admin/dashboard.html';
  return '/user/dashboard.html';
}

function getRoleLabel(role) {
  if (role === 'law_enforcement') return 'Law Enforcement';
  if (role === 'authorized_org') return 'Authorized Organization';
  if (role === 'admin') return 'System Admin';
  return 'Public User';
}

function signToken(user) {
  return jwt.sign(
    { user: { id: user._id, role: user.role } },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
}

function stripSensitiveUser(user) {
  if (!user) return user;
  const clone = { ...user };
  delete clone.password;
  delete clone.resetPasswordToken;
  delete clone.resetPasswordExpire;
  return clone;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidGmail(email) {
  return /^[^\s@]+@gmail\.com$/i.test(normalizeEmail(email));
}

function isStrongPassword(password) {
  return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(String(password || ''));
}

function isGoogleAuthEmailAllowed(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function isRestrictedRole(role) {
  return ['law_enforcement', 'authorized_org', 'admin'].includes(role);
}

async function findBestGoogleUser(normalizedEmail, googleUid) {
  const matches = await store.listUsers((u) => normalizeEmail(u.email) === normalizedEmail);
  if (!matches.length) return null;

  const exactGoogleUid = matches.find((u) => String(u.googleUid || '') === String(googleUid || ''));
  if (exactGoogleUid) return exactGoogleUid;

  const publicCandidate = matches.find((u) => !isRestrictedRole(u.role));
  if (publicCandidate) return publicCandidate;

  return matches[0];
}

async function ensureSystemAdminAccount() {
  const adminEmail = SYSTEM_ADMIN_EMAIL.toLowerCase();
  const existing = await store.findUserByEmail(adminEmail);
  const passwordHash = await bcrypt.hash(SYSTEM_ADMIN_PASSWORD, 10);

  if (!existing) {
    await store.createUser({
      username: 'System Admin',
      email: adminEmail,
      password: passwordHash,
      role: 'admin',
      organizationName: 'System Administration',
      verificationDocument: '',
      isVerified: true,
      verificationStatus: 'approved',
      verificationRejectionReason: ''
    });
    return;
  }

  await store.updateUser(existing._id, {
    password: passwordHash,
    role: 'admin',
    isVerified: true,
    verificationStatus: 'approved',
    verificationRejectionReason: ''
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5000000 },
  fileFilter: function fileFilter(req, file, cb) {
    const filetypes = /jpeg|jpg|png|webp|pdf/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Error: JPG, PNG, WEBP, and PDF files only!'));
  }
});

router.post(
  '/register',
  upload.fields([
    { name: 'verificationDoc', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 }
  ]),
  async (req, res) => {
  const {
    username,
    email,
    password,
    role,
    organizationName,
    station,
    dateOfBirth,
    idNumber
  } = req.body;

  try {
    await ensureSystemAdminAccount();

    const normalizedEmail = normalizeEmail(email);

    if (!isValidGmail(normalizedEmail)) {
      return res.status(400).json({ msg: 'Email must end with @gmail.com' });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ msg: 'Password must be at least 8 characters and include both letters and numbers.' });
    }

    const existing = await store.findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(400).json({ msg: 'User already exists' });
    }

    const needsApproval = role === 'law_enforcement' || role === 'authorized_org';
    const normalizedStation = (station || '').trim();
    const normalizedDob = (dateOfBirth || '').trim();
    const normalizedIdNumber = (idNumber || '').trim();

    if (needsApproval) {
      if (!normalizedStation || !normalizedDob || !normalizedIdNumber) {
        return res.status(400).json({
          msg: 'Station, date of birth, and ID/Service number are required for police and organization registration.'
        });
      }
    }

    let verificationDocument = '';
    const verificationDocFile = req.files?.verificationDoc?.[0];
    if (verificationDocFile) {
      const savedFile = await store.createFile({
        originalName: verificationDocFile.originalname,
        contentType: verificationDocFile.mimetype,
        size: verificationDocFile.size,
        dataBuffer: verificationDocFile.buffer,
        purpose: 'verification-doc'
      });
      verificationDocument = `api/files/${savedFile._id}`;
    }

    let profilePhoto = '';
    const profilePhotoFile = req.files?.profilePhoto?.[0];
    if (profilePhotoFile) {
      const savedPhoto = await store.createFile({
        originalName: profilePhotoFile.originalname,
        contentType: profilePhotoFile.mimetype,
        size: profilePhotoFile.size,
        dataBuffer: profilePhotoFile.buffer,
        purpose: 'registration-photo'
      });
      profilePhoto = `api/files/${savedPhoto._id}`;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await store.createUser({
      username,
      email: normalizedEmail,
      password: passwordHash,
      role,
      organizationName: organizationName || '',
      station: normalizedStation,
      dateOfBirth: normalizedDob,
      idNumber: normalizedIdNumber,
      profilePhoto,
      verificationDocument,
      isVerified: !needsApproval,
      verificationStatus: needsApproval ? 'pending' : 'approved',
      verificationRejectionReason: ''
    });

    await store.createActivityLog({
      type: needsApproval ? 'authority-registration-submitted' : 'user-registration-completed',
      actorId: user._id,
      actorName: user.username,
      actorRole: user.role,
      actorEmail: user.email,
      actorProfilePhoto: user.profilePhoto || null,
      target: { userId: user._id },
      details: {
        verificationStatus: user.verificationStatus,
        role: user.role,
        organizationName: user.organizationName || null
      }
    });

    // Send email asynchronously (non-blocking)
    const roleLabel = getRoleLabel(user.role);
    sendEmail({
      email: user.email,
      subject: needsApproval ? `Registration Received - ${roleLabel} Review Pending` : `Welcome to FindThem.AI - ${roleLabel} Account Created`,
      message: needsApproval
        ? `Hello ${user.username},\n\nYour ${roleLabel.toLowerCase()} registration has been submitted successfully and is currently pending system admin verification. You will receive another email once the review is completed.\n\nThank you for joining FindThem.AI.`
        : `Hello ${user.username},\n\nYour ${roleLabel.toLowerCase()} account has been created successfully. You can now sign in and use the platform to report or track missing person cases.\n\nThank you for joining FindThem.AI.`
    }).catch(emailErr => {
      console.error('Background email send failed:', emailErr);
    });

    if (needsApproval) {
      if (!verificationDocument) {
        return res.status(400).json({ msg: 'Please upload your verification document.' });
      }

      if (!profilePhoto) {
        return res.status(400).json({ msg: 'Please upload your profile photo.' });
      }

      return res.status(201).json({
        requiresApproval: true,
        msg: 'Registration submitted. A system admin will verify your ID document before account activation.'
      });
    }

    return res.json({
      token: signToken(user),
      role: user.role,
      redirectPath: getRedirectPath(user.role)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server error: ' + err.message });
  }
});

router.post('/google-public', async (req, res) => {
  try {
    await ensureSystemAdminAccount();

    const idToken = String(req.body.idToken || '').trim();
    if (!idToken) {
      return res.status(400).json({ msg: 'Google sign-in token is required.' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken, true);

    const firebaseUser = await admin.auth().getUser(decoded.uid);
    const tokenEmail = normalizeEmail(decoded.email);
    const verifiedEmail = normalizeEmail(firebaseUser.email);
    const submittedEmail = normalizeEmail(req.body.email);
    const normalizedEmail = verifiedEmail || tokenEmail;
    if (submittedEmail && verifiedEmail && submittedEmail !== verifiedEmail) {
      return res.status(400).json({ msg: 'Google account verification failed. Please try again.' });
    }
    if (!isGoogleAuthEmailAllowed(normalizedEmail)) {
      return res.status(400).json({
        msg: 'Google did not provide a valid email address. Ensure you signed in with a Google account and try again.'
      });
    }

    const existing = await findBestGoogleUser(normalizedEmail, decoded.uid);
    if (existing && isRestrictedRole(existing.role)) {
      return res.status(403).json({ msg: 'This email belongs to a restricted account. Google sign-in is only for public users.' });
    }

    let user = existing;
    const googleProfile = {
      authProvider: 'google',
      googleUid: decoded.uid,
      profilePhoto: existing?.profilePhoto || decoded.picture || '',
      isVerified: true,
      verificationStatus: 'approved',
      verificationRejectionReason: '',
      googleSignInAt: new Date().toISOString(),
      role: existing?.role || 'public_user'
    };

    if (!user) {
      const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      user = await store.createUser({
        username: decoded.name || normalizedEmail.split('@')[0] || 'Public User',
        email: normalizedEmail,
        password: randomPasswordHash,
        role: 'public_user',
        organizationName: '',
        station: '',
        dateOfBirth: '',
        idNumber: '',
        profilePhoto: decoded.picture || '',
        verificationDocument: '',
        isVerified: true,
        verificationStatus: 'approved',
        verificationRejectionReason: '',
        authProvider: 'google',
        googleUid: decoded.uid,
        googleSignInAt: new Date().toISOString()
      });

      await store.createActivityLog({
        type: 'public-google-registration',
        actorId: user._id,
        actorName: user.username,
        actorRole: user.role,
        actorEmail: user.email,
        actorProfilePhoto: user.profilePhoto || null,
        target: { userId: user._id },
        details: { authProvider: 'google' }
      });

      sendEmail({
        email: user.email,
        subject: 'Welcome to FindThem.AI - Public User Account Created',
        message: `Hello ${user.username},\n\nYour public user account has been created successfully using Google sign-in. You can now continue signing in with Google and access your dashboard.\n\nThank you for joining FindThem.AI.`
      }).catch((emailErr) => {
        console.error('Google registration email failed:', emailErr);
      });
    } else {
      user = await store.updateUser(user._id, googleProfile);
    }

    return res.json({
      token: signToken(user),
      role: user.role,
      redirectPath: getRedirectPath(user.role),
      email: user.email
    });
  } catch (err) {
    console.error(err);
    if (String(err && err.message || '').includes('Firebase ID token has expired')) {
      return res.status(401).json({ msg: 'Google sign-in expired. Please try again.' });
    }
    return res.status(500).json({ msg: err.message || 'Google sign-in failed' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    await ensureSystemAdminAccount();

    const normalizedEmail = normalizeEmail(email);

    const user = await store.findUserByEmail(normalizedEmail);
    if (!user) return res.status(400).json({ msg: 'Invalid Credentials' });

    const ok = await bcrypt.compare(password, user.password || '');
    if (!ok) return res.status(400).json({ msg: 'Invalid Credentials' });

    const verificationStatus = user.verificationStatus || (user.isVerified ? 'approved' : 'pending');
    if ((user.role === 'law_enforcement' || user.role === 'authorized_org') && verificationStatus !== 'approved') {
      if (verificationStatus === 'rejected') {
        return res.status(403).json({
          msg: `Registration rejected. Please resubmit your verification document.${user.verificationRejectionReason ? ` Reason: ${user.verificationRejectionReason}` : ''}`,
          verificationStatus: 'rejected'
        });
      }
      return res.status(403).json({
        msg: 'Registration pending system admin approval. You will be notified once review is complete.',
        verificationStatus: 'pending'
      });
    }

    return res.json({
      token: signToken(user),
      role: user.role,
      redirectPath: getRedirectPath(user.role)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/pending-registrations', auth(['admin']), async (req, res) => {
  try {
    const pendingUsers = await store.listUsers((u) =>
      ['law_enforcement', 'authorized_org'].includes(u.role) && u.verificationStatus === 'pending'
    );

    pendingUsers.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    return res.json(pendingUsers.map(stripSensitiveUser));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.get('/registration-review-summary', auth(['admin']), async (req, res) => {
  try {
    const reviewedUsers = await store.listUsers((u) =>
      ['law_enforcement', 'authorized_org'].includes(u.role) && ['pending', 'approved', 'rejected'].includes(u.verificationStatus)
    );

    const pending = reviewedUsers
      .filter((u) => u.verificationStatus === 'pending')
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

    const approved = reviewedUsers
      .filter((u) => u.verificationStatus === 'approved')
      .sort((a, b) => new Date(b.verificationReviewedAt || b.updatedAt || 0) - new Date(a.verificationReviewedAt || a.updatedAt || 0));

    const rejected = reviewedUsers
      .filter((u) => u.verificationStatus === 'rejected')
      .sort((a, b) => new Date(b.verificationReviewedAt || b.updatedAt || 0) - new Date(a.verificationReviewedAt || a.updatedAt || 0));

    return res.json({
      pending: pending.map(stripSensitiveUser),
      approved: approved.map(stripSensitiveUser),
      rejected: rejected.map(stripSensitiveUser)
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.put('/registrations/:id/approve', auth(['admin']), async (req, res) => {
  try {
    const user = await store.getUserById(req.params.id);
    const reviewer = await store.getUserById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (!['law_enforcement', 'authorized_org'].includes(user.role)) {
      return res.status(400).json({ msg: 'Only authority registrations require approval' });
    }

    await store.updateUser(user._id, {
      isVerified: true,
      verificationStatus: 'approved',
      verificationRejectionReason: '',
      verificationReviewedAt: new Date().toISOString(),
      verificationReviewedBy: req.user.id,
      verificationReviewedByName: reviewer?.username || 'System Admin'
    });

    await store.createActivityLog({
      type: 'registration-approved',
      actorId: reviewer?._id || req.user.id,
      actorName: reviewer?.username || 'System Admin',
      actorRole: reviewer?.role || req.user.role,
      actorEmail: reviewer?.email || null,
      actorProfilePhoto: reviewer?.profilePhoto || null,
      target: { userId: user._id },
      details: {
        approvedUser: user.username,
        approvedUserRole: user.role
      }
    });

    await store.createNotification({
      user: user._id,
      message: 'Your registration has been approved. You can now log in and use your account.'
    });

    // Send approval email asynchronously (non-blocking)
    sendEmail({
      email: user.email,
      subject: `Registration Approved - ${getRoleLabel(user.role)} Account`,
      message: `Hello ${user.username},\n\nYour ${getRoleLabel(user.role).toLowerCase()} registration has been approved by the system admin. You may now sign in and use your account.\n\nThank you for your patience.`
    }).catch(emailErr => {
      console.error('Approval email failed:', emailErr);
    });

    return res.json({ msg: 'Registration approved successfully' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.put('/registrations/:id/reject', auth(['admin']), async (req, res) => {
  try {
    const reason = (req.body.reason || '').trim();
    const user = await store.getUserById(req.params.id);
    const reviewer = await store.getUserById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    if (!['law_enforcement', 'authorized_org'].includes(user.role)) {
      return res.status(400).json({ msg: 'Only authority registrations require approval' });
    }

    await store.updateUser(user._id, {
      isVerified: false,
      verificationStatus: 'rejected',
      verificationRejectionReason: reason,
      verificationReviewedAt: new Date().toISOString(),
      verificationReviewedBy: req.user.id,
      verificationReviewedByName: reviewer?.username || 'System Admin'
    });

    await store.createActivityLog({
      type: 'registration-rejected',
      actorId: reviewer?._id || req.user.id,
      actorName: reviewer?.username || 'System Admin',
      actorRole: reviewer?.role || req.user.role,
      actorEmail: reviewer?.email || null,
      actorProfilePhoto: reviewer?.profilePhoto || null,
      target: { userId: user._id },
      details: {
        rejectedUser: user.username,
        rejectedUserRole: user.role,
        reason: reason || null
      }
    });

    await store.createNotification({
      user: user._id,
      message: `Your registration was not approved. Please resubmit your ID document.${reason ? ` Reason: ${reason}` : ''}`
    });

    // Send rejection email asynchronously (non-blocking)
    sendEmail({
      email: user.email,
      subject: `Registration Needs Resubmission - ${getRoleLabel(user.role)} Account`,
      message: `Hello ${user.username},\n\nYour ${getRoleLabel(user.role).toLowerCase()} registration was not approved at this time. Please resubmit your ID document or verification file and try again.${reason ? `\n\nReason: ${reason}` : ''}\n\nIf you have questions, please contact the system administrator.`
    }).catch(emailErr => {
      console.error('Rejection email failed:', emailErr);
    });

    return res.json({ msg: 'Registration rejected. User has been notified to resubmit.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/forgotpassword', async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);
    if (!isValidGmail(normalizedEmail)) {
      return res.status(400).json({ msg: 'Email must end with @gmail.com' });
    }

    const user = await store.findUserByEmail(normalizedEmail);
    if (!user) return res.status(404).json({ msg: 'User not found' });

    const resetToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetPasswordExpire = Date.now() + 10 * 60 * 1000;

    await store.updateUser(user._id, { resetPasswordToken, resetPasswordExpire });

    const frontendBase = process.env.FRONTEND_URL || 'https://missingpersonfinder-beryl.vercel.app';
    const resetUrl = `${frontendBase}/reset_password.html?token=${resetToken}`;

    try {
      // Timeout wrapper for password reset email (max 10 seconds)
      const emailPromise = sendEmail({
        email: user.email,
        subject: 'Password Reset Token',
        message: `You requested a password reset. Use this link: ${resetUrl}`
      });
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Email send timeout')), 10000)
      );
      
      await Promise.race([emailPromise, timeoutPromise]);
      return res.status(200).json({ success: true, data: 'Email sent' });
    } catch (err) {
      await store.updateUser(user._id, { resetPasswordToken: null, resetPasswordExpire: null });
      return res.status(500).json({ msg: 'Email could not be sent' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.post('/resetpassword/:resettoken', async (req, res) => {
  try {
    if (!isStrongPassword(req.body.password)) {
      return res.status(400).json({ msg: 'Password must be at least 8 characters and include both letters and numbers.' });
    }

    const resetPasswordToken = crypto.createHash('sha256').update(req.params.resettoken).digest('hex');
    const users = await store.listUsers((u) =>
      u.resetPasswordToken === resetPasswordToken && Number(u.resetPasswordExpire || 0) > Date.now()
    );

    const user = users[0];
    if (!user) return res.status(400).json({ msg: 'Invalid token' });

    const passwordHash = await bcrypt.hash(req.body.password, 10);
    await store.updateUser(user._id, {
      password: passwordHash,
      resetPasswordToken: null,
      resetPasswordExpire: null
    });

    return res.status(200).json({ success: true, data: 'Password updated' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/me', auth(), async (req, res) => {
  try {
    const user = await store.getUserById(req.user.id);
    if (!user) return res.status(404).json({ msg: 'User not found' });
    return res.json(stripSensitiveUser(user));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/admin/users', auth(['admin']), async (req, res) => {
  try {
    const users = await store.listUsers();
    const normalized = users
      .map(stripSensitiveUser)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json(normalized);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;

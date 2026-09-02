// NodeForge summary: Add interactive login page with validation, password visibility toggle, submission feedback, and home link.
'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [feedback, setFeedback] = useState('');

  const validate = () => {
    const nextErrors = {};
    if (!identifier.trim()) nextErrors.identifier = 'Enter your email or username.';
    if (!password) nextErrors.password = 'Enter your password.';
    return nextErrors;
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const nextErrors = validate();
    setErrors(nextErrors);
    setFeedback('');
    if (Object.keys(nextErrors).length === 0) {
      setFeedback('Your details are ready to be submitted.');
    }
  };

  return (
    <main
      style={{
        alignItems: 'center',
        background: 'linear-gradient(135deg, #f7faf6 0%, #e7f1e8 100%)',
        color: '#17211b',
        display: 'flex',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
      }}
    >
      <section style={{ background: '#fff', border: '1px solid #e1e9df', borderRadius: 20, boxShadow: '0 20px 55px rgba(31, 107, 71, 0.12)', maxWidth: 440, padding: 'clamp(28px, 6vw, 48px)', width: '100%' }}>
        <a href="/" style={{ color: '#2f855a', fontSize: 14, fontWeight: 700, textDecoration: 'none' }}>← Back home</a>
        <p style={{ color: '#2f855a', fontSize: 13, fontWeight: 750, letterSpacing: '0.14em', margin: '34px 0 12px', textTransform: 'uppercase' }}>Welcome back</p>
        <h1 style={{ fontSize: 'clamp(32px, 7vw, 48px)', letterSpacing: '-0.06em', lineHeight: 1, margin: 0 }}>Log in to NodeForge</h1>
        <p style={{ color: '#66736a', lineHeight: 1.6, margin: '16px 0 30px' }}>Continue building with your autonomous team.</p>
        <form noValidate onSubmit={handleSubmit}>
          <label htmlFor="identifier" style={{ display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Email or username</label>
          <input id="identifier" name="identifier" type="text" autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} aria-invalid={Boolean(errors.identifier)} aria-describedby={errors.identifier ? 'identifier-error' : undefined} style={{ border: `1px solid ${errors.identifier ? '#c53030' : '#d7e1d5'}`, borderRadius: 9, boxSizing: 'border-box', fontSize: 16, padding: '13px 14px', width: '100%' }} />
          {errors.identifier && <p id="identifier-error" style={{ color: '#c53030', fontSize: 13, margin: '7px 0 18px' }}>{errors.identifier}</p>}
          {!errors.identifier && <div style={{ height: 25 }} />}

          <label htmlFor="password" style={{ display: 'block', fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Password</label>
          <div style={{ position: 'relative' }}>
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? 'password-error' : undefined} style={{ border: `1px solid ${errors.password ? '#c53030' : '#d7e1d5'}`, borderRadius: 9, boxSizing: 'border-box', fontSize: 16, padding: '13px 76px 13px 14px', width: '100%' }} />
            <button type="button" onClick={() => setShowPassword((visible) => !visible)} style={{ background: 'transparent', border: 0, color: '#2f855a', cursor: 'pointer', fontSize: 13, fontWeight: 700, padding: 8, position: 'absolute', right: 7, top: 6 }}>{showPassword ? 'Hide' : 'Show'}</button>
          </div>
          {errors.password && <p id="password-error" style={{ color: '#c53030', fontSize: 13, margin: '7px 0 18px' }}>{errors.password}</p>}
          {!errors.password && <div style={{ height: 25 }} />}
          <button type="submit" style={{ background: '#1f6b47', border: 0, borderRadius: 9, color: '#fff', cursor: 'pointer', fontSize: 16, fontWeight: 700, padding: '14px 18px', width: '100%' }}>Log in</button>
          {feedback && <p role="status" style={{ color: '#26734d', fontSize: 14, margin: '16px 0 0', textAlign: 'center' }}>{feedback}</p>}
        </form>
      </section>
    </main>
  );
}

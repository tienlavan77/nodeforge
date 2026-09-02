// NodeForge summary: Agents page entry with shared navigation and agent workspace introduction.
import Header from '../../components/Header';

export default function AgentsPage() {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, var(--page-background, #f7faf6) 0%, var(--page-background-end, #edf4ed) 100%)',
        color: 'var(--page-text, #17211b)',
        minHeight: '100vh',
      }}
    >
      <Header />
      <main
        style={{
          margin: '0 auto',
          maxWidth: 1180,
          padding: 'clamp(64px, 10vw, 128px) clamp(20px, 5vw, 72px)',
        }}
      >
        <p
          style={{
            color: 'var(--page-accent, #2f855a)',
            fontSize: 13,
            fontWeight: 750,
            letterSpacing: '0.14em',
            margin: '0 0 18px',
            textTransform: 'uppercase',
          }}
        >
          Your autonomous team
        </p>
        <h1
          style={{
            fontSize: 'clamp(42px, 7vw, 82px)',
            letterSpacing: '-0.075em',
            lineHeight: 0.98,
            margin: 0,
            maxWidth: 760,
          }}
        >
          Meet your <span style={{ color: 'var(--page-accent, #2f855a)' }}>agents.</span>
        </h1>
        <p
          style={{
            color: 'var(--page-muted, #66736a)',
            fontSize: 'clamp(17px, 2vw, 20px)',
            lineHeight: 1.6,
            margin: '28px 0 0',
            maxWidth: 560,
          }}
        >
          Assemble a focused team of autonomous specialists to move ideas from first brief to production with confidence.
        </p>
      </main>
    </div>
  );
}

import { ExternalLink } from 'lucide-react';

// Google's Appointment Schedule pages send X-Frame-Options: SAMEORIGIN,
// so they can't be embedded in an iframe here — link out instead.
const BOOKING_URL = 'https://calendar.app.google/6SBWRPcUX7HeaAVh7';

const INCLUDED = [
  { label: 'Seats', detail: 'A custom number of seats for your team.' },
  { label: 'Dashboard', detail: 'Know how it\'s being used' },
  { label: 'Support', detail: 'Direct technical assistance from the team that builds Observer.' },
  { label: 'Infrastructure', detail: 'Runs on your own infrastructure, local-first, so sensitive data stays in your control.' },
];

const EnterpriseSection = () => {
  return (
    <section className="py-24 md:py-32 bg-[#0a0e17] border-t border-white/5" id="enterprise">
      <div className="container mx-auto px-6 max-w-4xl">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-16 items-start">
          {/* Left: pitch */}
          <div>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">
              Bringing Observer to your team?
            </h2>
            <p className="text-lg text-gray-400 mb-8">
              They save time, you save money.
            </p>
            <a
              href={BOOKING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 text-white font-medium border-b border-white/30 hover:border-white/70 transition-colors pb-0.5"
            >
              <span>Schedule a meeting</span>
              <ExternalLink className="w-3.5 h-3.5 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
            </a>
          </div>

          {/* Right: what's included, as a plain spec list */}
          <dl className="divide-y divide-white/10 border-t border-white/10">
            {INCLUDED.map((item) => (
              <div key={item.label} className="py-4 grid grid-cols-[7rem_1fr] gap-4">
                <dt className="text-sm text-gray-500">{item.label}</dt>
                <dd className="text-sm text-gray-300 leading-relaxed">{item.detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
};

export default EnterpriseSection;

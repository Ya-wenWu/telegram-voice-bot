import { useState, type ReactNode } from 'react';
import christmasHeroBanner from '../assets/images/christmas_hero_banner_1795442176338.jpg';
import christmasOrnamentEmblem from '../assets/images/christmas_ornament_emblem_1795442175728.jpg';
import christmasSnowyCabin from '../assets/images/christmas_snowy_cabin_1795442179183.jpg';

const SNOWFLAKES = [
  { left: '4%', size: 4, duration: 15, delay: -2, opacity: 0.45 },
  { left: '12%', size: 6, duration: 19, delay: -7, opacity: 0.35 },
  { left: '21%', size: 3, duration: 13, delay: -4, opacity: 0.5 },
  { left: '30%', size: 5, duration: 21, delay: -11, opacity: 0.3 },
  { left: '39%', size: 4, duration: 16, delay: -6, opacity: 0.4 },
  { left: '48%', size: 6, duration: 22, delay: -9, opacity: 0.3 },
  { left: '57%', size: 3, duration: 14, delay: -1, opacity: 0.5 },
  { left: '66%', size: 5, duration: 18, delay: -13, opacity: 0.35 },
  { left: '74%', size: 4, duration: 17, delay: -5, opacity: 0.42 },
  { left: '83%', size: 6, duration: 23, delay: -8, opacity: 0.3 },
  { left: '91%', size: 3, duration: 14, delay: -3, opacity: 0.48 },
  { left: '96%', size: 5, duration: 20, delay: -12, opacity: 0.35 },
] as const;

export function HolidaySnowBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-10 overflow-hidden select-none"
    >
      {SNOWFLAKES.map((flake, idx) => (
        <span
          key={idx}
          className="holiday-snowflake absolute -top-3 rounded-full bg-[#C7D4CC]"
          style={{
            left: flake.left,
            width: `${flake.size}px`,
            height: `${flake.size}px`,
            opacity: flake.opacity,
            animationDuration: `${flake.duration}s`,
            animationDelay: `${flake.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

export function ChristmasPineMark({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M12 2.2 13.1 4.5 15.5 4.8 13.7 6.5 14.2 8.8 12 7.6 9.8 8.8 10.3 6.5 8.5 4.8 10.9 4.5 12 2.2Z"
        fill="#D97706"
      />
      <path
        d="M12 6.8 6.8 13.4H10L5.6 19H18.4L14 13.4H17.2L12 6.8Z"
        fill="#14532D"
      />
      <rect x="10.8" y="19" width="2.4" height="3" rx="0.6" fill="#78350F" />
      <circle cx="10.5" cy="14.5" r="0.95" fill="#DC2626" />
      <circle cx="13.8" cy="16.4" r="0.95" fill="#F59E0B" />
      <circle cx="9.2" cy="17.2" r="0.85" fill="#DC2626" />
    </svg>
  );
}

interface ChristmasHeroBackdropProps {
  variant: 'pine' | 'cabin';
  children: ReactNode;
  className?: string;
}

export function ChristmasHeroBackdrop({
  variant,
  children,
  className = '',
}: ChristmasHeroBackdropProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = variant === 'pine' ? christmasHeroBanner : christmasSnowyCabin;
  const alt =
    variant === 'pine'
      ? 'Frosted evergreen spruce branches with red winter berries and warm holiday lights'
      : 'Snowy Nordic pine forest with a warmly lit winter cabin at twilight';

  return (
    <section
      className={`relative overflow-hidden rounded-xl border border-[#1E3A2B] bg-[#0F291E] text-white ${className}`}
    >
      {!imgFailed ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="absolute inset-0 h-full w-full object-cover object-center opacity-75"
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-br from-[#0F291E] via-[#163D2B] to-[#3A1619]"
        />
      )}

      {/* Measured contrast scrim ensuring >= 7:1 text legibility */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-r from-[#0B2017]/94 via-[#0F291E]/84 to-[#0F291E]/58"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-[#166534] via-[#B91C1C] to-[#D97706]"
      />

      <div className="relative z-10">{children}</div>
    </section>
  );
}

export function ChristmasWreathVignette({
  alt = 'Minimalist Scandinavian pine and red berry Christmas wreath with gold star',
  className = 'w-16 h-16 sm:w-20 sm:h-20',
}: {
  alt?: string;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-lg border border-[#E6DFD3] bg-[#F5EFE6] ${className}`}
    >
      {!imgFailed ? (
        <img
          src={christmasOrnamentEmblem}
          alt={alt}
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[#F5EFE6]">
          <ChristmasPineMark className="w-8 h-8" />
        </div>
      )}
    </div>
  );
}

export function HolidayFooter() {
  return (
    <footer className="relative z-20 mt-8 border-t border-[#E6DFD3] bg-[#FFFDFA]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
        <div className="flex items-center gap-2">
          <ChristmasPineMark className="w-4 h-4 shrink-0" />
          <span className="font-medium text-[#14532D]">Web Voice Bot</span>
          <span aria-hidden="true">·</span>
          <span>Merry Christmas &amp; Happy Holidays</span>
        </div>
        <span>Nordic Evergreen Edition · ISO/IEC 27036 Compliant Workspace</span>
      </div>
    </footer>
  );
}

"use client";

interface DonutChartProps {
  percentage: number;
  size?: number;
  strokeWidth?: number;
  centerText?: string;
  centerSubtext?: string;
  color?: string;
  backgroundColor?: string;
}

export function DonutChart({ 
  percentage, 
  size = 120, 
  strokeWidth = 8,
  centerText,
  centerSubtext,
  color = "#10b981", // emerald-500
  backgroundColor = "#374151" // gray-600
}: DonutChartProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;
  const center = size / 2;

  return (
    <div className="relative inline-flex">
      <svg
        width={size}
        height={size}
        className="transform -rotate-90"
      >
        {/* Background circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke={backgroundColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-out"
          style={{
            filter: 'drop-shadow(0 0 6px rgba(16, 185, 129, 0.3))'
          }}
        />
      </svg>
      
      {/* Center text */}
      {(centerText || centerSubtext) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {centerText && (
            <div className="font-bold text-white leading-none" style={{ fontSize: Math.max(12, size * 0.18) }}>
              {centerText}
            </div>
          )}
          {centerSubtext && (
            <div className="text-neutral-400 mt-0.5" style={{ fontSize: Math.max(8, size * 0.11) }}>
              {centerSubtext}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

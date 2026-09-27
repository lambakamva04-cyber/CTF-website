import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';

/**
 * Split into its own chunk and loaded on demand — recharts is by far the
 * heaviest dependency here, and the "Today" view never renders a chart.
 */
export default function TrendChart({ data }: { data: { label: string; count: number }[] }) {
  // The bars are a picture; a screen reader gets the same figures as a sentence.
  const summary = `Calls taken: ${data
    .map((point) => `${point.label}, ${point.count}`)
    .join('; ')}.`;

  return (
    <div role="img" aria-label={summary}>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            // The brand slate, 5.7:1 on white; the grey this replaced was 2.6:1.
            tick={{ fontSize: 11, fill: '#63666d' }}
          />
          <YAxis hide domain={[0, 'dataMax + 1']} />
          <Bar dataKey="count" fill="#000000" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

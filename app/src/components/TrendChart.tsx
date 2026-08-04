import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';

/**
 * Split into its own chunk and loaded on demand — recharts is by far the
 * heaviest dependency here, and the "Today" view never renders a chart.
 */
export default function TrendChart({ data }: { data: { label: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: '#9ca3af' }}
        />
        <YAxis hide domain={[0, 'dataMax + 1']} />
        <Bar dataKey="count" fill="#000000" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

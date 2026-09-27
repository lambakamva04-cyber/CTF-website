import { Check, Eye, EyeOff } from 'lucide-react';
import { useId, useState } from 'react';
import { checkPassword, type PasswordCheck } from '../../shared/password';

const STRENGTH_LABEL: Record<PasswordCheck['strength'], string> = {
  weak: 'Weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong',
};

/**
 * A password input with the requirements listed underneath, each ticking as it
 * is met, plus a strength meter.
 *
 * The rules come from shared/password.ts, which the server validates against
 * too. Listing them here from a separate copy is how a form ends up all green
 * and then rejected on submit.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete = 'new-password',
  showRequirements = true,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  showRequirements?: boolean;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  const listId = useId();
  const result = checkPassword(value);
  const started = value.length > 0;

  return (
    <div className="space-y-2">
      {/* The label names the input alone. It used to wrap the show/hide button
          too, which is invalid HTML and let the button's name leak into the
          field's ("Password Show password"). */}
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-xs font-medium text-slate">
          {label}
        </label>
        <div className="relative">
          <input
            id={inputId}
            // Toggling type rather than rendering two inputs keeps the value,
            // the cursor position and the password manager's binding intact.
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            autoComplete={autoComplete}
            autoFocus={autoFocus}
            aria-describedby={showRequirements ? listId : undefined}
            className="w-full border border-field rounded-xl px-4 py-2.5 pr-11 text-sm focus:outline-none focus:border-black"
          />
          <button
            type="button"
            onClick={() => setVisible((previous) => !previous)}
            // Being able to see what you typed is a security feature, not a
            // hole: it is what lets someone confidently use a long password
            // instead of a short one they can retype blind.
            aria-label={visible ? 'Hide password' : 'Show password'}
            // p-1 around a 16px icon: a 24px target, the WCAG 2.2 minimum.
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-slate hover:text-black transition"
          >
            {visible ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {showRequirements && (
        <div id={listId} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    started && result.score >= step ? 'bg-ink' : 'bg-gray-200'
                  }`}
                />
              ))}
            </span>
            <span className="text-[0.65rem] uppercase tracking-widest text-slate w-12 text-right">
              {started ? STRENGTH_LABEL[result.strength] : ''}
            </span>
          </div>

          {/* aria-live so a screen reader hears each requirement being met as
              it happens, rather than the user having to go hunting for why the
              button is still disabled. */}
          <ul className="space-y-1" aria-live="polite">
            {result.rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`h-3.5 w-3.5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                    rule.met ? 'bg-green-600' : 'bg-gray-200'
                  }`}
                >
                  {rule.met && (
                    <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} aria-hidden="true" />
                  )}
                </span>
                <span className={rule.met ? 'text-green-700' : 'text-slate'}>{rule.label}</span>
                {/* The tick is colour plus a shape, and the state is also in
                    the text, so this does not rely on distinguishing green
                    from grey. */}
                <span className="sr-only">{rule.met ? '— met' : '— not yet met'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

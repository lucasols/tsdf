import { useState } from 'react';
import {
  addProfileCredits,
  profileStore,
  renameProfile,
} from '../stores/profileStore';

export function AccountPanel() {
  const profile = profileStore.useDocument({ returnRefetchingStatus: true });
  const criticalTag = profileStore.useListItem({
    itemId: 'tag-critical',
    selector: (data) =>
      data?.tags.find((tag) => tag.id === 'tag-critical') ?? null,
    loadItemFallback: () => {
      profileStore.scheduleFetch('highPriority');
    },
  });
  const [draftName, setDraftName] = useState(profile.data?.name ?? '');

  const name = profile.data?.name ?? 'Loading account';

  return (
    <section className="account-band">
      <div className="account-copy">
        <p className="app-kicker">Account</p>
        <h2>{name}</h2>
        <p>
          {profile.data?.plan ?? 'No plan'} workspace with{' '}
          {profile.data?.credits ?? 0} credits available.
        </p>
      </div>

      <div className="account-actions">
        <label className="field">
          Account name
          <input
            value={draftName || profile.data?.name || ''}
            onChange={(event) => setDraftName(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            void renameProfile(draftName || name);
          }}
        >
          Save account
        </button>
        <button
          type="button"
          onClick={() => {
            void addProfileCredits(5);
          }}
        >
          Add credits
        </button>
      </div>

      <div className="account-metrics">
        <div>
          <span>Status</span>
          <strong>{profile.status}</strong>
        </div>
        <div>
          <span>Priority label</span>
          <strong>
            {criticalTag.isLoading
              ? 'Loading'
              : (criticalTag.data?.label ?? 'None')}
          </strong>
        </div>
      </div>
    </section>
  );
}

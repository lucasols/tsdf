import { useState } from 'react';
import type { ContactFilter, ContactStatus, ContactTeam } from '../apiTypes';
import {
  contactListStore,
  createContact,
  deleteContact,
  renameContact,
  toggleContactStatus,
} from '../stores/contactListStore';

const CONTACT_ROW_FIELDS = ['id', 'name', 'team', 'status'];

export function ContactsPanel() {
  const [filter, setFilter] = useState<ContactFilter>({
    team: 'all',
    status: 'all',
  });
  const [selectedContactId, setSelectedContactId] = useState('ada');
  const [draftName, setDraftName] = useState('Ada Lovelace');
  const query = contactListStore.useListQuery(filter, {
    fields: CONTACT_ROW_FIELDS,
    loadSize: 4,
    showPartialAsRefetching: true,
    returnRefetchingStatus: true,
  });
  const selectedContact = contactListStore.useItem(selectedContactId, {
    fields: '*',
    returnRefetchingStatus: true,
    showPartialAsRefetching: true,
  });
  const foundPaused = contactListStore.useFindItem(
    (item) => item.status === 'paused',
    { selector: (item) => item.name ?? item.id },
  );

  return (
    <section className="work-section contacts-section">
      <div className="section-heading">
        <div>
          <p className="app-kicker">Relationships</p>
          <h2>Contacts</h2>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            void createContact().then((contact) => {
              if (!contact) return;
              setSelectedContactId(contact.id);
              setDraftName(contact.name ?? contact.id);
            });
          }}
        >
          New contact
        </button>
      </div>

      <div className="filter-row">
        <label className="field">
          Team
          <select
            value={filter.team}
            onChange={(event) => {
              setFilter((current) => ({
                ...current,
                team: event.currentTarget.value as ContactTeam | 'all',
              }));
            }}
          >
            <option value="all">All</option>
            <option value="design">Design</option>
            <option value="engineering">Engineering</option>
            <option value="product">Product</option>
          </select>
        </label>
        <label className="field">
          Status
          <select
            value={filter.status}
            onChange={(event) => {
              setFilter((current) => ({
                ...current,
                status: event.currentTarget.value as ContactStatus | 'all',
              }));
            }}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
      </div>

      <div className="contact-layout">
        <div className="table-shell">
          <div className="table-header">
            <span>{query.items.length} contacts loaded</span>
            <span>{query.hasMore ? 'More available' : 'All visible'}</span>
          </div>
          <div className="contact-table">
            {query.items.map((contact, index) => (
              <button
                key={`${contact.id}:${index}`}
                type="button"
                className={
                  contact.id === selectedContactId ? 'selected-row' : ''
                }
                onClick={() => {
                  setSelectedContactId(contact.id);
                  setDraftName(contact.name ?? contact.id);
                }}
              >
                <span>{contact.name ?? contact.id}</span>
                <span>{contact.team ?? 'Partial'}</span>
                <span>{contact.status ?? 'Partial'}</span>
              </button>
            ))}
          </div>
          {query.hasMore ? (
            <button
              type="button"
              className="load-more-button"
              onClick={() => {
                contactListStore.loadMore(filter, {
                  size: 3,
                  fields: CONTACT_ROW_FIELDS,
                });
              }}
            >
              Load more contacts
            </button>
          ) : null}
        </div>

        <div className="detail-pane">
          <div>
            <p className="app-kicker">Selected contact</p>
            <h3>{selectedContact.data?.name ?? selectedContactId}</h3>
          </div>
          <label className="field">
            Name
            <input
              value={draftName}
              onChange={(event) => setDraftName(event.currentTarget.value)}
            />
          </label>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{selectedContact.data?.status ?? selectedContact.status}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{selectedContact.data?.email ?? 'Not loaded'}</dd>
            </div>
            <div>
              <dt>Notes</dt>
              <dd>{selectedContact.data?.notes ?? 'Not loaded'}</dd>
            </div>
            <div>
              <dt>Paused lead</dt>
              <dd>{foundPaused ?? 'No local match'}</dd>
            </div>
          </dl>
          <div className="inline-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                void renameContact(selectedContactId, draftName);
              }}
            >
              Save contact
            </button>
            <button
              type="button"
              onClick={() => {
                void toggleContactStatus(selectedContactId);
              }}
            >
              Toggle status
            </button>
            <button
              type="button"
              onClick={() => {
                void deleteContact(selectedContactId);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

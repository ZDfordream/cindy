export type BillingSettingsIdentity = {
  mode: 'signed-out' | 'local' | 'cloud' | 'hr';
  membershipKind: 'personal' | 'org' | null;
};

export function canAccessBillingSettings(identity: BillingSettingsIdentity): boolean {
  return identity.mode === 'cloud' && identity.membershipKind === 'personal';
}

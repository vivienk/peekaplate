export type DishVerificationStatus = 'not_verified' | 'verified';
export type PhotoVerificationStatus = 'not_verified' | 'verified' | 'rejected';

export interface VerifyDishResponse {
  draft: {
    id: string;
    verificationStatus: DishVerificationStatus;
    updatedAt: string;
  };
}

export interface PromotePhotoResponse {
  photo: {
    id: string;
    draftId: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    verificationStatus: PhotoVerificationStatus;
    storageKey: string;
    promotedStorageKey?: string | null;
  };
}

export async function verifyDishOnBackend(
  apiOrigin: string,
  token: string,
  venueId: string,
  draftId: string,
  verified = true,
): Promise<VerifyDishResponse> {
  const commandId = crypto.randomUUID();
  const res = await fetch(`${apiOrigin}/venues/${venueId}/drafts/${draftId}/verify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ commandId, verified }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'request_failed' }));
    throw new Error(err.error || `Failed with status ${res.status}`);
  }
  return res.json();
}

export async function approvePhotoOnBackend(
  apiOrigin: string,
  token: string,
  venueId: string,
  draftId: string,
  photoId: string,
): Promise<PromotePhotoResponse> {
  const commandId = crypto.randomUUID();
  const res = await fetch(
    `${apiOrigin}/venues/${venueId}/drafts/${draftId}/photos/${photoId}/approve`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ commandId }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'request_failed' }));
    throw new Error(err.error || `Failed with status ${res.status}`);
  }
  return res.json();
}

export async function publishMenuOnBackend(
  apiOrigin: string,
  token: string,
  venueId: string,
  menuId: string,
): Promise<{ status: 'published'; publishedAt: string }> {
  const commandId = crypto.randomUUID();
  const res = await fetch(`${apiOrigin}/venues/${venueId}/menus/${menuId}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ commandId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'request_failed' }));
    throw new Error(err.error || `Failed with status ${res.status}`);
  }
  return res.json();
}

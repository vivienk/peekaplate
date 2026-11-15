// FE-05: the S05 Restaurant details form data and its browser-side checks. The screen sends nothing
// itself; the caller saves through onSave (Amr's S05 handoff). Exact validation rules and wording
// are TBD in the handoff; these follow the Figma Validation error frame and the sign-in screens.

export type RestaurantDetails = {
  name: string;
  city: string;
  street: string;
  line2: string;
  phone: string;
  email: string;
};

export type DetailsField = keyof RestaurantDetails;

export const EMPTY_DETAILS: RestaurantDetails = {
  name: '',
  city: '',
  street: '',
  line2: '',
  phone: '',
  email: '',
};

// Restaurant name, city, street address and phone number are required; address line 2 and contact
// email are optional (S05 handoff, section 1).
export const REQUIRED_FIELDS: readonly DetailsField[] = ['name', 'city', 'street', 'phone'];

// Digits with the usual separators, 7 to 15 digits in all (the E.164 maximum).
const PHONE_FORMAT = /^\+?[\d\s().-]+$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function fieldError(field: DetailsField, raw: string): string | undefined {
  const value = raw.trim();
  switch (field) {
    case 'name':
      return value ? undefined : 'Enter your restaurant name';
    case 'city':
      return value ? undefined : 'Enter your city';
    case 'street':
      return value ? undefined : 'Enter your street address';
    case 'phone': {
      if (!value) return 'Enter your phone number';
      const digits = value.replace(/\D/g, '').length;
      return PHONE_FORMAT.test(value) && digits >= 7 && digits <= 15
        ? undefined
        : 'Enter a valid phone number';
    }
    case 'email':
      return !value || (value.length <= 254 && EMAIL_FORMAT.test(value))
        ? undefined
        : 'Enter a valid email address';
    case 'line2':
      return undefined;
  }
}

export function detailsErrors(details: RestaurantDetails): Partial<Record<DetailsField, string>> {
  const errors: Partial<Record<DetailsField, string>> = {};
  for (const field of Object.keys(details) as DetailsField[]) {
    const error = fieldError(field, details[field]);
    if (error) errors[field] = error;
  }
  return errors;
}

export function trimDetails(details: RestaurantDetails): RestaurantDetails {
  return {
    name: details.name.trim(),
    city: details.city.trim(),
    street: details.street.trim(),
    line2: details.line2.trim(),
    phone: details.phone.trim(),
    email: details.email.trim(),
  };
}

// True when any value differs from the saved one, ignoring surrounding spaces (S05 handoff, section
// 5: restoring every original value disables Save again).
export function detailsChanged(a: RestaurantDetails, b: RestaurantDetails): boolean {
  const left = trimDetails(a);
  const right = trimDetails(b);
  return (Object.keys(left) as DetailsField[]).some((field) => left[field] !== right[field]);
}

// The restaurant photo (logo): JPEG or PNG, up to 12 MB like the menu uploads. The handoff does not
// state a limit for this photo; flagged in the PR.
export const PHOTO_TYPES = ['image/jpeg', 'image/png'] as const;
export const MAX_PHOTO_BYTES = 12_000_000;

export function photoError(file: File): string | undefined {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) {
    return 'Choose a JPEG or PNG image';
  }
  return file.size > MAX_PHOTO_BYTES ? 'Choose an image up to 12 MB' : undefined;
}

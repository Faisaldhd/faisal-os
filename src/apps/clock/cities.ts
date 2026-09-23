/** A catalog of cities available to add to the World tab, each with an IANA time zone. */
export interface CityDef {
  id: string;
  name: { ar: string; en: string };
  tz: string;
}

export const CITY_CATALOG: CityDef[] = [
  { id: 'riyadh', name: { ar: 'الرياض', en: 'Riyadh' }, tz: 'Asia/Riyadh' },
  { id: 'makkah', name: { ar: 'مكة المكرمة', en: 'Makkah' }, tz: 'Asia/Riyadh' },
  { id: 'jeddah', name: { ar: 'جدة', en: 'Jeddah' }, tz: 'Asia/Riyadh' },
  { id: 'dubai', name: { ar: 'دبي', en: 'Dubai' }, tz: 'Asia/Dubai' },
  { id: 'doha', name: { ar: 'الدوحة', en: 'Doha' }, tz: 'Asia/Qatar' },
  { id: 'kuwait', name: { ar: 'الكويت', en: 'Kuwait City' }, tz: 'Asia/Kuwait' },
  { id: 'cairo', name: { ar: 'القاهرة', en: 'Cairo' }, tz: 'Africa/Cairo' },
  { id: 'amman', name: { ar: 'عمّان', en: 'Amman' }, tz: 'Asia/Amman' },
  { id: 'baghdad', name: { ar: 'بغداد', en: 'Baghdad' }, tz: 'Asia/Baghdad' },
  { id: 'beirut', name: { ar: 'بيروت', en: 'Beirut' }, tz: 'Asia/Beirut' },
  { id: 'casablanca', name: { ar: 'الدار البيضاء', en: 'Casablanca' }, tz: 'Africa/Casablanca' },
  { id: 'tunis', name: { ar: 'تونس', en: 'Tunis' }, tz: 'Africa/Tunis' },
  { id: 'istanbul', name: { ar: 'إسطنبول', en: 'Istanbul' }, tz: 'Europe/Istanbul' },
  { id: 'london', name: { ar: 'لندن', en: 'London' }, tz: 'Europe/London' },
  { id: 'paris', name: { ar: 'باريس', en: 'Paris' }, tz: 'Europe/Paris' },
  { id: 'berlin', name: { ar: 'برلين', en: 'Berlin' }, tz: 'Europe/Berlin' },
  { id: 'moscow', name: { ar: 'موسكو', en: 'Moscow' }, tz: 'Europe/Moscow' },
  { id: 'newyork', name: { ar: 'نيويورك', en: 'New York' }, tz: 'America/New_York' },
  { id: 'losangeles', name: { ar: 'لوس أنجلوس', en: 'Los Angeles' }, tz: 'America/Los_Angeles' },
  { id: 'chicago', name: { ar: 'شيكاغو', en: 'Chicago' }, tz: 'America/Chicago' },
  { id: 'toronto', name: { ar: 'تورنتو', en: 'Toronto' }, tz: 'America/Toronto' },
  { id: 'saopaulo', name: { ar: 'ساو باولو', en: 'São Paulo' }, tz: 'America/Sao_Paulo' },
  { id: 'tokyo', name: { ar: 'طوكيو', en: 'Tokyo' }, tz: 'Asia/Tokyo' },
  { id: 'beijing', name: { ar: 'بكين', en: 'Beijing' }, tz: 'Asia/Shanghai' },
  { id: 'singapore', name: { ar: 'سنغافورة', en: 'Singapore' }, tz: 'Asia/Singapore' },
  { id: 'delhi', name: { ar: 'نيودلهي', en: 'New Delhi' }, tz: 'Asia/Kolkata' },
  { id: 'karachi', name: { ar: 'كراتشي', en: 'Karachi' }, tz: 'Asia/Karachi' },
  { id: 'jakarta', name: { ar: 'جاكرتا', en: 'Jakarta' }, tz: 'Asia/Jakarta' },
  { id: 'sydney', name: { ar: 'سيدني', en: 'Sydney' }, tz: 'Australia/Sydney' },
  { id: 'auckland', name: { ar: 'أوكلاند', en: 'Auckland' }, tz: 'Pacific/Auckland' },
];

export const DEFAULT_CITY_IDS = ['riyadh', 'makkah', 'dubai', 'cairo', 'london', 'newyork', 'tokyo'];

export function findCity(id: string): CityDef | undefined {
  return CITY_CATALOG.find((c) => c.id === id);
}

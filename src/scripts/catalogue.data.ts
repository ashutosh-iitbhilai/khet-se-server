import type { IProduct } from '../models/Product';

type Seed = Omit<IProduct, 'createdAt' | 'updatedAt' | 'isActive'>;

/**
 * Catalogue photos are self-hosted by the web client (client/public/images/catalogue)
 * so they load fast and never depend on third-party hotlinking or rate limits.
 * Paths are relative to the client origin; uploaded images use absolute https URLs.
 */
const local = (slug: string) => `/images/catalogue/${slug}.jpg`;
const credit = (file: string, license: string) =>
  `${license} · Wikimedia Commons · https://commons.wikimedia.org/wiki/File:${file}`;

/**
 * Starter catalogue. Farmers pick from this list and add their own price/stock.
 * Admins can extend it via POST /api/products.
 */
export const CATALOGUE: Seed[] = [
  // ── Fresh ────────────────────────────────────────────────────────────────
  { slug: 'tomato', name: 'Tomato', localName: 'Tamatar', type: 'fresh', category: 'fruiting', defaultUnit: 'kg', shelfLifeDays: 7,
    description: 'Vine-ripened desi tomatoes, tangy and juicy.', image: local('tomato'), imageCredit: 'Unsplash License · https://unsplash.com/license' },
  { slug: 'potato', name: 'Potato', localName: 'Aloo', type: 'fresh', category: 'roots-tubers', defaultUnit: 'kg', shelfLifeDays: 30,
    description: 'Freshly dug potatoes with thin skins.', image: local('potato'), imageCredit: 'Unsplash License · https://unsplash.com/license' },
  { slug: 'onion', name: 'Onion', localName: 'Pyaaz', type: 'fresh', category: 'bulbs', defaultUnit: 'kg', shelfLifeDays: 30,
    description: 'Red onions, field-cured for a longer shelf life.', image: local('onion'), imageCredit: 'Unsplash License · https://unsplash.com/license' },
  { slug: 'spinach', name: 'Spinach', localName: 'Palak', type: 'fresh', category: 'leafy-greens', defaultUnit: 'bunch', shelfLifeDays: 3,
    description: 'Tender green spinach leaves, cut the same morning.', image: local('spinach'), imageCredit: 'Unsplash License · https://unsplash.com/license' },
  { slug: 'cauliflower', name: 'Cauliflower', localName: 'Phool Gobhi', type: 'fresh', category: 'cruciferous', defaultUnit: 'piece', shelfLifeDays: 5,
    description: 'Tight, creamy-white heads.', image: local('cauliflower'), imageCredit: 'Unsplash License · https://unsplash.com/license' },
  { slug: 'carrot', name: 'Carrot', localName: 'Gajar', type: 'fresh', category: 'roots-tubers', defaultUnit: 'kg', shelfLifeDays: 14,
    description: 'Sweet, crunchy carrots.', image: local('carrot'), imageCredit: 'Unsplash License · https://unsplash.com/license' },
  { slug: 'cabbage', name: 'Cabbage', localName: 'Patta Gobhi', type: 'fresh', category: 'cruciferous', defaultUnit: 'piece', shelfLifeDays: 14,
    description: 'Firm green cabbage heads.', image: local('cabbage'),
    imageCredit: credit('Cabbages_at_Gara_market,_Srikakulam.jpg', 'CC0') },
  { slug: 'brinjal', name: 'Brinjal', localName: 'Baingan', type: 'fresh', category: 'fruiting', defaultUnit: 'kg', shelfLifeDays: 6,
    description: 'Glossy purple brinjal, ideal for bharta.', image: local('brinjal'),
    imageCredit: credit('Brinjal_eggplant_1.jpg', 'CC BY-SA 4.0') },
  { slug: 'okra', name: 'Okra', localName: 'Bhindi', type: 'fresh', category: 'fruiting', defaultUnit: 'kg', shelfLifeDays: 4,
    description: 'Young, tender lady finger.', image: local('okra'), imageCredit: credit('Okra_season.jpg', 'CC BY-SA 4.0') },
  { slug: 'green-peas', name: 'Green Peas', localName: 'Matar', type: 'fresh', category: 'beans-pods', defaultUnit: 'kg', shelfLifeDays: 5,
    description: 'Sweet peas in the pod.', image: local('green-peas'), imageCredit: credit('Green_pea_pods.jpg', 'CC0') },
  { slug: 'green-beans', name: 'Green Beans', localName: 'Beans', type: 'fresh', category: 'beans-pods', defaultUnit: 'kg', shelfLifeDays: 5,
    description: 'Crisp, stringless beans.', image: local('green-beans'),
    imageCredit: credit('Green_beans_displayed_for_sell.jpg', 'CC BY-SA 4.0') },
  { slug: 'green-chilli', name: 'Green Chilli', localName: 'Hari Mirch', type: 'fresh', category: 'fruiting', defaultUnit: 'kg', shelfLifeDays: 7,
    description: 'Fresh, hot green chillies.', image: local('green-chilli'),
    imageCredit: credit('Green_chillies_Kerala.jpg', 'CC BY-SA 4.0') },
  { slug: 'coriander', name: 'Coriander', localName: 'Dhaniya', type: 'fresh', category: 'herbs', defaultUnit: 'bunch', shelfLifeDays: 4,
    description: 'Fragrant coriander bunches with roots.', image: local('coriander'),
    imageCredit: credit('Bunches_of_coriander_leaves.jpg', 'CC BY-SA 4.0') },
  { slug: 'garlic', name: 'Garlic', localName: 'Lehsun', type: 'fresh', category: 'bulbs', defaultUnit: 'kg', shelfLifeDays: 90,
    description: 'Pungent desi garlic bulbs.', image: local('garlic'),
    imageCredit: credit('Garlic_Bulbs_(Unsplash).jpg', 'CC0') },

  // ── Dry ──────────────────────────────────────────────────────────────────
  { slug: 'dried-red-chilli', name: 'Dried Red Chilli', localName: 'Sukhi Lal Mirch', type: 'dry', category: 'sun-dried', defaultUnit: 'packet', shelfLifeDays: 365,
    description: 'Whole sun-dried red chillies, deep colour and heat.', image: local('dried-red-chilli'),
    imageCredit: credit('Dried_red_chillies_in_Jaipur.jpg', 'CC0') },
  { slug: 'sun-dried-tomato', name: 'Sun-dried Tomato', type: 'dry', category: 'sun-dried', defaultUnit: 'packet', shelfLifeDays: 270,
    description: 'Tomato halves dried slowly in the sun.', image: local('sun-dried-tomato'),
    imageCredit: credit('Sun-dried_tomatoes.jpg', 'CC BY 2.0') },
  { slug: 'dried-onion', name: 'Dried Onion', localName: 'Sukha Pyaaz', type: 'dry', category: 'sun-dried', defaultUnit: 'packet', shelfLifeDays: 365,
    description: 'Air-dried onions for long storage.', image: local('dried-onion'), imageCredit: credit('Dried_onion.jpg', 'CC BY-SA 4.0') },
  { slug: 'kasuri-methi', name: 'Kasuri Methi', localName: 'Dried Fenugreek Leaves', type: 'dry', category: 'dried-leaves', defaultUnit: 'packet', shelfLifeDays: 365,
    description: 'Shade-dried fenugreek leaves.', image: local('kasuri-methi'),
    imageCredit: credit('Dried_leaves_of_Fenugreek-Kasuri_Methi.jpg', 'CC BY-SA 4.0') },
  { slug: 'dehydrated-vegetable-mix', name: 'Dehydrated Vegetable Mix', type: 'dry', category: 'dehydrated-mix', defaultUnit: 'packet', shelfLifeDays: 270,
    description: 'Carrot, beans, peas and greens — just add water.', image: local('dehydrated-vegetable-mix'),
    imageCredit: credit('Joint_venture_dehydrated_dried_vegetables.jpg', 'CC0') },
];

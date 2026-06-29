export interface Product {
  id: number;
  title: string;
  price: number;
  image: string;
  alt: string;
  description: string;
}

export const products: Product[] = [
  {
    id: 1,
    title: 'Stratus Wireless Headphones',
    price: 129.0,
    image: '/images/product-1.png',
    alt: 'Stratus wireless over-ear headphones in slate gray',
    description: 'Studio-grade sound with 30-hour battery life.',
  },
  {
    id: 2,
    title: 'Cumulus Desk Lamp',
    price: 48.5,
    image: '/images/product-2.png',
    alt: 'Cumulus minimalist LED desk lamp',
    description: 'Warm, dimmable light for late-night sessions.',
  },
  {
    id: 3,
    // BUG: image file does not exist -> 404; alt is empty (a11y issue)
    title: 'Nimbus Mechanical Keyboard',
    price: 89.99,
    image: '/images/product-3.png',
    alt: '',
    description: 'Tactile switches and a low-profile aluminum frame.',
  },
  {
    id: 4,
    title: 'Altocumulus Travel Mug',
    price: 24.0,
    image: '/images/product-4.png',
    alt: 'Altocumulus insulated stainless steel travel mug',
    description: 'Keeps drinks hot for 12 hours, cold for 24.',
  },
];

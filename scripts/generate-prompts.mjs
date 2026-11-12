import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_DIR = join(process.cwd(), 'src', 'eval', 'prompts');

const jsonExtractionPrompts = [
  {
    id: '01',
    text: 'Profile: Alex Mercer is a 29-year-old software engineer reachable at alex.mercer@example.com.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer', minimum: 0 },
        email: { type: 'string' },
      },
      required: ['name', 'age', 'email'],
    },
    answer: { name: 'Alex Mercer', age: 29, email: 'alex.mercer@example.com' },
  },
  {
    id: '02',
    text: 'Book entry: "Dune" was authored by Frank Herbert in 1965. Genres include "Sci-Fi" and "Adventure".',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        author: { type: 'string' },
        publicationYear: { type: 'integer' },
        genres: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'author', 'publicationYear', 'genres'],
    },
    answer: {
      title: 'Dune',
      author: 'Frank Herbert',
      publicationYear: 1965,
      genres: ['Sci-Fi', 'Adventure'],
    },
  },
  {
    id: '03',
    text: 'Inventory item: Product SKU-7890 (Wireless Mouse) costs 29.99 USD, is currently inStock (true), tagged under ["electronics", "peripherals"].',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        price: { type: 'number', minimum: 0 },
        inStock: { type: 'boolean' },
        categories: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name', 'price', 'inStock', 'categories'],
    },
    answer: {
      id: 'SKU-7890',
      name: 'Wireless Mouse',
      price: 29.99,
      inStock: true,
      categories: ['electronics', 'peripherals'],
    },
  },
  {
    id: '04',
    text: 'Address: 742 Evergreen Terrace, Springfield, OR, 97477, USA.',
    schema: {
      type: 'object',
      properties: {
        street: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        postalCode: { type: 'string' },
        country: { type: 'string' },
      },
      required: ['street', 'city', 'state', 'postalCode', 'country'],
    },
    answer: {
      street: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'OR',
      postalCode: '97477',
      country: 'USA',
    },
  },
  {
    id: '05',
    text: 'Flight: Flight AA-102 departing JFK for LHR with a total duration of 420 minutes.',
    schema: {
      type: 'object',
      properties: {
        flightNumber: { type: 'string' },
        departureAirport: { type: 'string' },
        arrivalAirport: { type: 'string' },
        durationMinutes: { type: 'integer', minimum: 1 },
      },
      required: ['flightNumber', 'departureAirport', 'arrivalAirport', 'durationMinutes'],
    },
    answer: {
      flightNumber: 'AA-102',
      departureAirport: 'JFK',
      arrivalAirport: 'LHR',
      durationMinutes: 420,
    },
  },
  {
    id: '06',
    text: 'Film: "Inception" directed by Christopher Nolan, released in 2010, grossed 836.8 million dollars, starring ["Leonardo DiCaprio", "Joseph Gordon-Levitt"].',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        director: { type: 'string' },
        releaseYear: { type: 'integer' },
        boxOfficeMillions: { type: 'number' },
        cast: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'director', 'releaseYear', 'boxOfficeMillions', 'cast'],
    },
    answer: {
      title: 'Inception',
      director: 'Christopher Nolan',
      releaseYear: 2010,
      boxOfficeMillions: 836.8,
      cast: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt'],
    },
  },
  {
    id: '07',
    text: 'Recipe: Classic Pancakes takes 20 minutes to prepare, serves 4 people, ingredients are ["flour", "milk", "eggs", "sugar"].',
    schema: {
      type: 'object',
      properties: {
        recipeName: { type: 'string' },
        prepTimeMinutes: { type: 'integer' },
        servings: { type: 'integer' },
        ingredients: { type: 'array', items: { type: 'string' } },
      },
      required: ['recipeName', 'prepTimeMinutes', 'servings', 'ingredients'],
    },
    answer: {
      recipeName: 'Classic Pancakes',
      prepTimeMinutes: 20,
      servings: 4,
      ingredients: ['flour', 'milk', 'eggs', 'sugar'],
    },
  },
  {
    id: '08',
    text: 'Weather: In Tokyo, current temperature is 18.5 Celsius, humidity is 65 percent, and conditions are "Clear".',
    schema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        temperatureCelsius: { type: 'number' },
        humidityPercent: { type: 'integer' },
        condition: { type: 'string' },
      },
      required: ['location', 'temperatureCelsius', 'humidityPercent', 'condition'],
    },
    answer: {
      location: 'Tokyo',
      temperatureCelsius: 18.5,
      humidityPercent: 65,
      condition: 'Clear',
    },
  },
  {
    id: '09',
    text: 'Transaction TXN-4491 processed an amount of 149.50 USD with successful status (true).',
    schema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        isSuccess: { type: 'boolean' },
      },
      required: ['transactionId', 'amount', 'currency', 'isSuccess'],
    },
    answer: {
      transactionId: 'TXN-4491',
      amount: 149.5,
      currency: 'USD',
      isSuccess: true,
    },
  },
  {
    id: '10',
    text: 'Employee: EMP-104 is Jordan Lee, Department: Engineering, Role: Senior Architect, Active: true.',
    schema: {
      type: 'object',
      properties: {
        employeeId: { type: 'string' },
        fullName: { type: 'string' },
        department: { type: 'string' },
        role: { type: 'string' },
        active: { type: 'boolean' },
      },
      required: ['employeeId', 'fullName', 'department', 'role', 'active'],
    },
    answer: {
      employeeId: 'EMP-104',
      fullName: 'Jordan Lee',
      department: 'Engineering',
      role: 'Senior Architect',
      active: true,
    },
  },
  {
    id: '11',
    text: 'Conference: "Tech Summit 2026" on 2026-10-15 at "Moscone Center", max capacity 5000, tags: ["tech", "ai", "cloud"].',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string' },
        venue: { type: 'string' },
        capacity: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'date', 'venue', 'capacity', 'tags'],
    },
    answer: {
      title: 'Tech Summit 2026',
      date: '2026-10-15',
      venue: 'Moscone Center',
      capacity: 5000,
      tags: ['tech', 'ai', 'cloud'],
    },
  },
  {
    id: '12',
    text: 'Vehicle: Tesla Model 3, year 2023, mileage 15000, fuelType "electric".',
    schema: {
      type: 'object',
      properties: {
        make: { type: 'string' },
        model: { type: 'string' },
        year: { type: 'integer' },
        mileage: { type: 'integer' },
        fuelType: { type: 'string' },
      },
      required: ['make', 'model', 'year', 'mileage', 'fuelType'],
    },
    answer: {
      make: 'Tesla',
      model: 'Model 3',
      year: 2023,
      mileage: 15000,
      fuelType: 'electric',
    },
  },
  {
    id: '13',
    text: 'Server node-web-01 at 192.168.1.50 has CPU usage of 42.8 percent and status "healthy".',
    schema: {
      type: 'object',
      properties: {
        hostname: { type: 'string' },
        ipAddress: { type: 'string' },
        cpuUsagePercent: { type: 'number' },
        status: { type: 'string' },
      },
      required: ['hostname', 'ipAddress', 'cpuUsagePercent', 'status'],
    },
    answer: {
      hostname: 'node-web-01',
      ipAddress: '192.168.1.50',
      cpuUsagePercent: 42.8,
      status: 'healthy',
    },
  },
  {
    id: '14',
    text: 'Grade record: Student Maya Lin scored 94.5 in Mathematics, received grade "A", passed: true.',
    schema: {
      type: 'object',
      properties: {
        studentName: { type: 'string' },
        subject: { type: 'string' },
        score: { type: 'number' },
        letterGrade: { type: 'string' },
        passed: { type: 'boolean' },
      },
      required: ['studentName', 'subject', 'score', 'letterGrade', 'passed'],
    },
    answer: {
      studentName: 'Maya Lin',
      subject: 'Mathematics',
      score: 94.5,
      letterGrade: 'A',
      passed: true,
    },
  },
  {
    id: '15',
    text: 'Support ticket TKT-802 from client dev@corp.io: Priority "high", subject "API latency spike", closed: false.',
    schema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        customerEmail: { type: 'string' },
        priority: { type: 'string' },
        subject: { type: 'string' },
        closed: { type: 'boolean' },
      },
      required: ['ticketId', 'customerEmail', 'priority', 'subject', 'closed'],
    },
    answer: {
      ticketId: 'TKT-802',
      customerEmail: 'dev@corp.io',
      priority: 'high',
      subject: 'API latency spike',
      closed: false,
    },
  },
  {
    id: '16',
    text: 'Hotel reservation RES-5512 for guest David Kim, 3 nights in a "Deluxe Suite", total amount 750.00.',
    schema: {
      type: 'object',
      properties: {
        reservationId: { type: 'string' },
        guestName: { type: 'string' },
        nights: { type: 'integer' },
        roomType: { type: 'string' },
        totalPaid: { type: 'number' },
      },
      required: ['reservationId', 'guestName', 'nights', 'roomType', 'totalPaid'],
    },
    answer: {
      reservationId: 'RES-5512',
      guestName: 'David Kim',
      nights: 3,
      roomType: 'Deluxe Suite',
      totalPaid: 750.0,
    },
  },
  {
    id: '17',
    text: 'Invoice INV-2026-09 for Acme Corp due 2026-11-30: Subtotal 1000.00, Tax 85.00, Total 1085.00.',
    schema: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string' },
        clientName: { type: 'string' },
        dueDate: { type: 'string' },
        subtotal: { type: 'number' },
        tax: { type: 'number' },
        total: { type: 'number' },
      },
      required: ['invoiceNumber', 'clientName', 'dueDate', 'subtotal', 'tax', 'total'],
    },
    answer: {
      invoiceNumber: 'INV-2026-09',
      clientName: 'Acme Corp',
      dueDate: '2026-11-30',
      subtotal: 1000.0,
      tax: 85.0,
      total: 1085.0,
    },
  },
  {
    id: '18',
    text: 'Appointment: Patient PAT-330 with Dr. Sarah Smith (Cardiology) on 2026-12-05, confirmed: true.',
    schema: {
      type: 'object',
      properties: {
        patientId: { type: 'string' },
        doctorName: { type: 'string' },
        specialty: { type: 'string' },
        appointmentDate: { type: 'string' },
        confirmed: { type: 'boolean' },
      },
      required: ['patientId', 'doctorName', 'specialty', 'appointmentDate', 'confirmed'],
    },
    answer: {
      patientId: 'PAT-330',
      doctorName: 'Dr. Sarah Smith',
      specialty: 'Cardiology',
      appointmentDate: '2026-12-05',
      confirmed: true,
    },
  },
  {
    id: '19',
    text: 'Shipment 1Z999AA10123456784 via UPS, weight 2.75 kg, delivered status: true.',
    schema: {
      type: 'object',
      properties: {
        trackingNumber: { type: 'string' },
        carrier: { type: 'string' },
        weightKg: { type: 'number' },
        delivered: { type: 'boolean' },
      },
      required: ['trackingNumber', 'carrier', 'weightKg', 'delivered'],
    },
    answer: {
      trackingNumber: '1Z999AA10123456784',
      carrier: 'UPS',
      weightKg: 2.75,
      delivered: true,
    },
  },
  {
    id: '20',
    text: 'Review by TechFan: Rating 5 stars, title "Excellent device", verifiedPurchase: true.',
    schema: {
      type: 'object',
      properties: {
        reviewer: { type: 'string' },
        rating: { type: 'integer', minimum: 1, maximum: 5 },
        title: { type: 'string' },
        verifiedPurchase: { type: 'boolean' },
      },
      required: ['reviewer', 'rating', 'title', 'verifiedPurchase'],
    },
    answer: {
      reviewer: 'TechFan',
      rating: 5,
      title: 'Excellent device',
      verifiedPurchase: true,
    },
  },
  {
    id: '21',
    text: 'Account details: Account ACCT-8921 is a "Checking" account with balance 4520.75 USD.',
    schema: {
      type: 'object',
      properties: {
        accountNumber: { type: 'string' },
        accountType: { type: 'string' },
        currentBalance: { type: 'number' },
        currency: { type: 'string' },
      },
      required: ['accountNumber', 'accountType', 'currentBalance', 'currency'],
    },
    answer: {
      accountNumber: 'ACCT-8921',
      accountType: 'Checking',
      currentBalance: 4520.75,
      currency: 'USD',
    },
  },
  {
    id: '22',
    text: 'Commit a1b2c3d by committer Jane Doe: "fix(core): resolve race condition in pool", filesChanged: 4.',
    schema: {
      type: 'object',
      properties: {
        hash: { type: 'string' },
        author: { type: 'string' },
        message: { type: 'string' },
        filesChanged: { type: 'integer' },
      },
      required: ['hash', 'author', 'message', 'filesChanged'],
    },
    answer: {
      hash: 'a1b2c3d',
      author: 'Jane Doe',
      message: 'fix(core): resolve race condition in pool',
      filesChanged: 4,
    },
  },
  {
    id: '23',
    text: 'Podcast episode: "The Changelog", episodeNumber 550, hosted by Adam Stacoviak, runtime 65 minutes.',
    schema: {
      type: 'object',
      properties: {
        showName: { type: 'string' },
        episodeNumber: { type: 'integer' },
        host: { type: 'string' },
        minutes: { type: 'integer' },
      },
      required: ['showName', 'episodeNumber', 'host', 'minutes'],
    },
    answer: {
      showName: 'The Changelog',
      episodeNumber: 550,
      host: 'Adam Stacoviak',
      minutes: 65,
    },
  },
  {
    id: '24',
    text: 'Job vacancy: "Staff Backend Engineer" at Stripe, remote: true, required experience: 7 years.',
    schema: {
      type: 'object',
      properties: {
        jobTitle: { type: 'string' },
        company: { type: 'string' },
        remote: { type: 'boolean' },
        experienceYears: { type: 'integer' },
      },
      required: ['jobTitle', 'company', 'remote', 'experienceYears'],
    },
    answer: {
      jobTitle: 'Staff Backend Engineer',
      company: 'Stripe',
      remote: true,
      experienceYears: 7,
    },
  },
  {
    id: '25',
    text: 'Subscription: "Team Plan" costs 49.00 per month, supports up to 10 users and 200 GB storage.',
    schema: {
      type: 'object',
      properties: {
        planName: { type: 'string' },
        monthlyCost: { type: 'number' },
        maxUsers: { type: 'integer' },
        storageGb: { type: 'integer' },
      },
      required: ['planName', 'monthlyCost', 'maxUsers', 'storageGb'],
    },
    answer: {
      planName: 'Team Plan',
      monthlyCost: 49.0,
      maxUsers: 10,
      storageGb: 200,
    },
  },
];

const mathPrompts = [
  { id: '01', q: 'Compute 482 + 379 - 146.', a: 715 },
  { id: '02', q: 'What is 34 * 28?', a: 952 },
  { id: '03', q: 'What is 1024 / 16?', a: 64 },
  { id: '04', q: 'Evaluate: 14 + 6 * (8 - 3)^2.', a: 164 },
  { id: '05', q: 'What is 35% of 420?', a: 147 },
  { id: '06', q: 'Calculate 2^11.', a: 2048 },
  { id: '07', q: 'Calculate 7! (7 factorial).', a: 5040 },
  { id: '08', q: 'What is the greatest common divisor (GCD) of 72 and 120?', a: 24 },
  { id: '09', q: 'What is the least common multiple (LCM) of 14 and 35?', a: 70 },
  { id: '10', q: 'Solve for x: 5x - 17 = 78. What is the value of x?', a: 19 },
  { id: '11', q: 'Find the larger positive root of x^2 - 11x + 28 = 0.', a: 7 },
  {
    id: '12',
    q: 'A rectangle has length 23 cm and width 14 cm. What is its perimeter in cm?',
    a: 74,
  },
  { id: '13', q: 'What is the area of a triangle with base 18 cm and height 13 cm?', a: 117 },
  { id: '14', q: 'A circle has radius 14. Using pi = 22/7, calculate the area.', a: 616 },
  { id: '15', q: 'Find the arithmetic mean of 24, 38, 45, 52, and 61.', a: 44 },
  {
    id: '16',
    q: 'Calculate the total simple interest on a principal of $2500 at 6% per year for 4 years.',
    a: 600,
  },
  { id: '17', q: 'What is the 12th term of the arithmetic progression 5, 9, 13, 17...?', a: 49 },
  { id: '18', q: 'What is the sum of all integers from 1 to 100?', a: 5050 },
  { id: '19', q: 'Evaluate combinations C(8, 3) = 8! / (3! * 5!).', a: 56 },
  { id: '20', q: 'Evaluate permutations P(6, 2) = 6! / (6 - 2)!.', a: 30 },
  { id: '21', q: 'How many seconds are in 2.5 hours?', a: 9000 },
  {
    id: '22',
    q: 'A car travels 315 miles in 4.5 hours. What is its average speed in miles per hour?',
    a: 70,
  },
  { id: '23', q: 'What is the 10th prime number (starting with 2 as the 1st prime)?', a: 29 },
  { id: '24', q: 'Compute (23^3) mod 7.', a: 1 },
  {
    id: '25',
    q: 'In a right triangle with legs of length 9 and 12, what is the length of the hypotenuse?',
    a: 15,
  },
];

const codePrompts = [
  {
    id: '01',
    prompt: 'Write a JavaScript function `add(a, b)` that returns the sum of two numbers.',
    entrypoint: 'add',
    code: 'function add(a, b) { return a + b; }',
    testCases: [
      { input: [1, 2], expected: 3 },
      { input: [-5, 5], expected: 0 },
      { input: [100, 250], expected: 350 },
    ],
  },
  {
    id: '02',
    prompt:
      'Write a JavaScript function `isEven(n)` that returns true if n is even, false otherwise.',
    entrypoint: 'isEven',
    code: 'function isEven(n) { return n % 2 === 0; }',
    testCases: [
      { input: [4], expected: true },
      { input: [7], expected: false },
      { input: [0], expected: true },
      { input: [-2], expected: true },
    ],
  },
  {
    id: '03',
    prompt: 'Write a JavaScript function `reverseString(str)` that returns the string reversed.',
    entrypoint: 'reverseString',
    code: "function reverseString(str) { return str.split('').reverse().join(''); }",
    testCases: [
      { input: ['hello'], expected: 'olleh' },
      { input: ['world'], expected: 'dlrow' },
      { input: [''], expected: '' },
    ],
  },
  {
    id: '04',
    prompt: 'Write a JavaScript function `factorial(n)` that computes n factorial for n >= 0.',
    entrypoint: 'factorial',
    code: 'function factorial(n) { if (n <= 1) return 1; let res = 1; for (let i = 2; i <= n; i++) res *= i; return res; }',
    testCases: [
      { input: [0], expected: 1 },
      { input: [1], expected: 1 },
      { input: [5], expected: 120 },
      { input: [6], expected: 720 },
    ],
  },
  {
    id: '05',
    prompt:
      'Write a JavaScript function `findMax(arr)` that returns the maximum number in a non-empty array.',
    entrypoint: 'findMax',
    code: 'function findMax(arr) { return Math.max(...arr); }',
    testCases: [
      { input: [[1, 5, 3, 9, 2]], expected: 9 },
      { input: [[-10, -5, -20]], expected: -5 },
      { input: [[42]], expected: 42 },
    ],
  },
  {
    id: '06',
    prompt:
      'Write a JavaScript function `isPalindrome(str)` that returns true if the string is a palindrome (ignoring non-alphanumeric characters and case).',
    entrypoint: 'isPalindrome',
    code: "function isPalindrome(str) { const clean = str.toLowerCase().replace(/[^a-z0-9]/g, ''); return clean === clean.split('').reverse().join(''); }",
    testCases: [
      { input: ['Racecar'], expected: true },
      { input: ['A man, a plan, a canal: Panama'], expected: true },
      { input: ['hello'], expected: false },
    ],
  },
  {
    id: '07',
    prompt:
      'Write a JavaScript function `fibonacci(n)` that returns the nth Fibonacci number with fib(0) = 0 and fib(1) = 1.',
    entrypoint: 'fibonacci',
    code: 'function fibonacci(n) { if (n <= 0) return 0; if (n === 1) return 1; let a = 0, b = 1; for (let i = 2; i <= n; i++) { const c = a + b; a = b; b = c; } return b; }',
    testCases: [
      { input: [0], expected: 0 },
      { input: [1], expected: 1 },
      { input: [6], expected: 8 },
      { input: [10], expected: 55 },
    ],
  },
  {
    id: '08',
    prompt:
      'Write a JavaScript function `countVowels(str)` that returns the count of vowels (a, e, i, o, u case-insensitive) in the string.',
    entrypoint: 'countVowels',
    code: 'function countVowels(str) { const matches = str.match(/[aeiou]/gi); return matches ? matches.length : 0; }',
    testCases: [
      { input: ['hello'], expected: 2 },
      { input: ['AEIOU'], expected: 5 },
      { input: ['rhythm'], expected: 0 },
    ],
  },
  {
    id: '09',
    prompt:
      'Write a JavaScript function `sumArray(arr)` that returns the sum of numbers in an array.',
    entrypoint: 'sumArray',
    code: 'function sumArray(arr) { return arr.reduce((acc, x) => acc + x, 0); }',
    testCases: [
      { input: [[1, 2, 3, 4]], expected: 10 },
      { input: [[]], expected: 0 },
      { input: [[-1, 1, -2, 2]], expected: 0 },
    ],
  },
  {
    id: '10',
    prompt:
      'Write a JavaScript function `capitalizeWords(str)` that capitalizes the first letter of each space-separated word.',
    entrypoint: 'capitalizeWords',
    code: "function capitalizeWords(str) { if (!str) return ''; return str.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : '').join(' '); }",
    testCases: [
      { input: ['hello world'], expected: 'Hello World' },
      { input: ['gateway eval test'], expected: 'Gateway Eval Test' },
    ],
  },
  {
    id: '11',
    prompt:
      'Write a JavaScript function `filterEvens(arr)` that returns an array containing only the even numbers.',
    entrypoint: 'filterEvens',
    code: 'function filterEvens(arr) { return arr.filter(x => x % 2 === 0); }',
    testCases: [
      { input: [[1, 2, 3, 4, 5, 6]], expected: [2, 4, 6] },
      { input: [[1, 3, 5]], expected: [] },
      { input: [[0, 8, -4]], expected: [0, 8, -4] },
    ],
  },
  {
    id: '12',
    prompt:
      'Write a JavaScript function `twoSum(nums, target)` that returns the pair of indices [i, j] such that nums[i] + nums[j] === target.',
    entrypoint: 'twoSum',
    code: 'function twoSum(nums, target) { const map = new Map(); for (let i = 0; i < nums.length; i++) { const comp = target - nums[i]; if (map.has(comp)) return [map.get(comp), i]; map.set(nums[i], i); } return []; }',
    testCases: [
      { input: [[2, 7, 11, 15], 9], expected: [0, 1] },
      { input: [[3, 2, 4], 6], expected: [1, 2] },
    ],
  },
  {
    id: '13',
    prompt:
      'Write a JavaScript function `flatten(arr)` that flattens an array of arrays by one level.',
    entrypoint: 'flatten',
    code: 'function flatten(arr) { return [].concat(...arr); }',
    testCases: [
      {
        input: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
        expected: [1, 2, 3, 4],
      },
      { input: [[[1], [2], [3]]], expected: [1, 2, 3] },
      { input: [[]], expected: [] },
    ],
  },
  {
    id: '14',
    prompt:
      'Write a JavaScript function `removeDuplicates(arr)` that removes duplicate values preserving their first occurrence order.',
    entrypoint: 'removeDuplicates',
    code: 'function removeDuplicates(arr) { return Array.from(new Set(arr)); }',
    testCases: [
      { input: [[1, 2, 2, 3, 4, 4, 5]], expected: [1, 2, 3, 4, 5] },
      { input: [['a', 'b', 'a']], expected: ['a', 'b'] },
    ],
  },
  {
    id: '15',
    prompt:
      'Write a JavaScript function `chunkArray(arr, size)` that splits an array into subarrays of given size.',
    entrypoint: 'chunkArray',
    code: 'function chunkArray(arr, size) { const res = []; for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size)); return res; }',
    testCases: [
      { input: [[1, 2, 3, 4, 5], 2], expected: [[1, 2], [3, 4], [5]] },
      {
        input: [[1, 2, 3, 4], 2],
        expected: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
  },
  {
    id: '16',
    prompt:
      "Write a JavaScript function `truncateString(str, num)` that truncates str if its length exceeds num and appends '...'.",
    entrypoint: 'truncateString',
    code: "function truncateString(str, num) { return str.length > num ? str.slice(0, num) + '...' : str; }",
    testCases: [
      { input: ['Hello World', 5], expected: 'Hello...' },
      { input: ['Short', 10], expected: 'Short' },
    ],
  },
  {
    id: '17',
    prompt:
      'Write a JavaScript function `isAnagram(s1, s2)` that returns true if s1 and s2 are anagrams (ignoring spaces and case).',
    entrypoint: 'isAnagram',
    code: "function isAnagram(s1, s2) { const clean = s => s.toLowerCase().replace(/\\s+/g, '').split('').sort().join(''); return clean(s1) === clean(s2); }",
    testCases: [
      { input: ['listen', 'silent'], expected: true },
      { input: ['rail safety', 'fairy tales'], expected: true },
      { input: ['hello', 'world'], expected: false },
    ],
  },
  {
    id: '18',
    prompt:
      'Write a JavaScript function `gcd(a, b)` that returns the greatest common divisor of positive integers a and b.',
    entrypoint: 'gcd',
    code: 'function gcd(a, b) { while (b !== 0) { const t = b; b = a % b; a = t; } return a; }',
    testCases: [
      { input: [48, 18], expected: 6 },
      { input: [101, 10], expected: 1 },
      { input: [54, 24], expected: 6 },
    ],
  },
  {
    id: '19',
    prompt:
      'Write a JavaScript function `titleCase(str)` that formats words to have first letter capitalized and rest lowercased.',
    entrypoint: 'titleCase',
    code: 'function titleCase(str) { return str.toLowerCase().replace(/(^|\\s)\\w/g, m => m.toUpperCase()); }',
    testCases: [
      { input: ['tHe sUn ALSo riSEs'], expected: 'The Sun Also Rises' },
      { input: ['quick brown fox'], expected: 'Quick Brown Fox' },
    ],
  },
  {
    id: '20',
    prompt:
      'Write a JavaScript function `intersection(arr1, arr2)` that returns an array of unique values found in both arr1 and arr2.',
    entrypoint: 'intersection',
    code: 'function intersection(arr1, arr2) { const s2 = new Set(arr2); return Array.from(new Set(arr1.filter(x => s2.has(x)))); }',
    testCases: [
      {
        input: [
          [1, 2, 2, 1],
          [2, 2],
        ],
        expected: [2],
      },
      {
        input: [
          [4, 9, 5],
          [9, 4, 9, 8, 4],
        ],
        expected: [4, 9],
      },
    ],
  },
  {
    id: '21',
    prompt:
      'Write a JavaScript function `clamp(val, min, max)` that constrains val within the range [min, max].',
    entrypoint: 'clamp',
    code: 'function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }',
    testCases: [
      { input: [5, 1, 10], expected: 5 },
      { input: [-3, 0, 10], expected: 0 },
      { input: [15, 0, 10], expected: 10 },
    ],
  },
  {
    id: '22',
    prompt:
      'Write a JavaScript function `mergeObjects(obj1, obj2)` that returns a new object with obj2 properties overriding obj1.',
    entrypoint: 'mergeObjects',
    code: 'function mergeObjects(obj1, obj2) { return Object.assign({}, obj1, obj2); }',
    testCases: [
      {
        input: [
          { a: 1, b: 2 },
          { b: 3, c: 4 },
        ],
        expected: { a: 1, b: 3, c: 4 },
      },
      { input: [{ x: 10 }, {}], expected: { x: 10 } },
    ],
  },
  {
    id: '23',
    prompt:
      'Write a JavaScript function `isValidEmail(email)` that checks if string has a non-empty user, @, non-empty domain, and dot in domain.',
    entrypoint: 'isValidEmail',
    code: 'function isValidEmail(email) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email); }',
    testCases: [
      { input: ['test@example.com'], expected: true },
      { input: ['invalid-email'], expected: false },
      { input: ['user@domain'], expected: false },
    ],
  },
  {
    id: '24',
    prompt:
      'Write a JavaScript function `countOccurrences(arr, val)` that returns how many times val occurs in arr.',
    entrypoint: 'countOccurrences',
    code: 'function countOccurrences(arr, val) { return arr.filter(x => x === val).length; }',
    testCases: [
      { input: [[1, 2, 3, 2, 2, 4], 2], expected: 3 },
      { input: [['a', 'b', 'c'], 'z'], expected: 0 },
    ],
  },
  {
    id: '25',
    prompt:
      'Write a JavaScript function `deepEqual(a, b)` that returns true if two JSON-compatible values are deeply identical.',
    entrypoint: 'deepEqual',
    code: 'function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }',
    testCases: [
      {
        input: [
          { a: 1, b: [2, 3] },
          { a: 1, b: [2, 3] },
        ],
        expected: true,
      },
      { input: [{ a: 1 }, { a: 2 }], expected: false },
    ],
  },
];

const structuredExtractionPrompts = [
  {
    id: '01',
    text: 'Invoice from CloudHost Inc: Invoice #INV-9901 issued on 2026-05-12 for a total of $320.50.',
    target: { vendor: 'CloudHost Inc', invoice_id: 'INV-9901', total: 320.5, date: '2026-05-12' },
  },
  {
    id: '02',
    text: 'Boarding Pass: Passenger Robert Langdon aboard Delta Airlines flight DL442 seated in 14B.',
    target: {
      passenger: 'Robert Langdon',
      airline: 'Delta Airlines',
      flight_number: 'DL442',
      seat_number: '14B',
    },
  },
  {
    id: '03',
    text: 'Diagnostic report for patient Emily Watson: Test Glucose measured at 98.4 with normal range 70-99.',
    target: {
      patient_name: 'Emily Watson',
      test_type: 'Glucose',
      test_value: 98.4,
      normal_range: '70-99',
    },
  },
  {
    id: '04',
    text: 'Shipping dispatch to recipient Michael Chang via FedEx under tracking 774892019283 weighing 4.2 kg.',
    target: {
      recipient_name: 'Michael Chang',
      courier: 'FedEx',
      tracking_id: '774892019283',
      weight_kg: 4.2,
    },
  },
  {
    id: '05',
    text: 'Real estate: 124 Ocean Drive features 4 bedrooms and 3 bathrooms, listed at $850000.',
    target: {
      property_address: '124 Ocean Drive',
      bedrooms: 4,
      bathrooms: 3,
      listing_price: 850000,
    },
  },
  {
    id: '06',
    text: 'Candidate profile: Sarah Connor applied for DevOps Lead with 8 years of experience coming from Cyberdyne Systems.',
    target: {
      candidate_name: 'Sarah Connor',
      applied_role: 'DevOps Lead',
      total_experience_years: 8,
      previous_employer: 'Cyberdyne Systems',
    },
  },
  {
    id: '07',
    text: 'Meeting log: Host Alan Turing scheduled conference on 2026-08-10 lasting 45 minutes regarding Cryptanalysis.',
    target: {
      host_name: 'Alan Turing',
      meeting_date: '2026-08-10',
      duration_minutes: 45,
      agenda_topic: 'Cryptanalysis',
    },
  },
  {
    id: '08',
    text: 'Restaurant receipt for customer Bruce Wayne: party of 2, subtotal $180.00, gratuity $36.00.',
    target: { guest_name: 'Bruce Wayne', party_size: 2, bill_subtotal: 180.0, gratuity: 36.0 },
  },
  {
    id: '09',
    text: 'Vehicle title registration: Owner Tony Stark registered VIN 1HGCR2F83HA001290, Make Audi, Model Year 2024.',
    target: {
      owner_full_name: 'Tony Stark',
      vin: '1HGCR2F83HA001290',
      vehicle_make: 'Audi',
      model_year: 2024,
    },
  },
  {
    id: '10',
    text: 'Weather warning: Region Northwest issued alert Severe for Blizzard expiring at 18:00 UTC.',
    target: {
      region: 'Northwest',
      alert_level: 'Severe',
      weather_phenomenon: 'Blizzard',
      expiry_time: '18:00 UTC',
    },
  },
  {
    id: '11',
    text: 'Hotel departure folio: Guest Clara Oswald in room 404 stayed 5 nights with final charge $1125.00.',
    target: {
      guest_full_name: 'Clara Oswald',
      room_number: 404,
      total_nights: 5,
      total_charged: 1125.0,
    },
  },
  {
    id: '12',
    text: 'Defect ticket filed by Arthur Dent: Severity Critical in module AuthRouter, status Open.',
    target: {
      reporter: 'Arthur Dent',
      defect_severity: 'Critical',
      affected_module: 'AuthRouter',
      resolution_status: 'Open',
    },
  },
  {
    id: '13',
    text: 'Card alert: Card ending in 4112 charged $89.99 at BestBuy, transaction authorized: true.',
    target: {
      card_last4: '4112',
      charge_amount: 89.99,
      merchant_name: 'BestBuy',
      authorized: true,
    },
  },
  {
    id: '14',
    text: 'Academic catalog: CS301 offered by Computer Science carries 4 credits taught by Prof. Knuth.',
    target: {
      course_code: 'CS301',
      faculty_department: 'Computer Science',
      credit_hours: 4,
      lead_instructor: 'Prof. Knuth',
    },
  },
  {
    id: '15',
    text: 'Lease contract: Tenant Peter Parker leased apartment 3B for 12 months at $1450 per month.',
    target: {
      tenant_name: 'Peter Parker',
      apartment_number: '3B',
      monthly_rental_rate: 1450,
      lease_term_months: 12,
    },
  },
  {
    id: '16',
    text: 'Claim document: Policyholder Diana Prince under policy POL-7721 claimed loss $4500.00, decision Approved.',
    target: {
      policyholder: 'Diana Prince',
      policy_reference: 'POL-7721',
      claimed_loss_amount: 4500.0,
      claim_decision: 'Approved',
    },
  },
  {
    id: '17',
    text: 'Daily activity for Barry Allen: Logged 18500 steps across 14.2 km burning 920 calories.',
    target: {
      athlete: 'Barry Allen',
      steps_logged: 18500,
      kilometers_covered: 14.2,
      active_calories: 920,
    },
  },
  {
    id: '18',
    text: 'Concert pass: Red Rocks venue hosting Daft Punk in Section VIP at price $250.00.',
    target: {
      event_venue: 'Red Rocks',
      performer: 'Daft Punk',
      seating_section: 'VIP',
      admission_cost: 250.0,
    },
  },
  {
    id: '19',
    text: 'Energy utility statement: Account ACCT-501 recorded Electric meter usage of 640 kWh totaling $89.60.',
    target: {
      account_holder_id: 'ACCT-501',
      meter_type: 'Electric',
      kilowatt_hours: 640,
      amount_payable: 89.6,
    },
  },
  {
    id: '20',
    text: 'Library loan: Borrower Hermione Granger checked out ISBN 9780747532743 due 2026-09-20, renewals: 1.',
    target: {
      borrower_name: 'Hermione Granger',
      book_isbn: '9780747532743',
      return_due_date: '2026-09-20',
      renewal_count: 1,
    },
  },
  {
    id: '21',
    text: 'Enterprise software agreement: Organization Wayne Enterprises licensed Enterprise tier for 500 users of SecurityGuard.',
    target: {
      organization: 'Wayne Enterprises',
      software_suite: 'SecurityGuard',
      subscription_tier: 'Enterprise',
      user_licenses: 500,
    },
  },
  {
    id: '22',
    text: 'Patient vitals for ID PAT-909: Blood pressure 120 systolic over 80 diastolic with heart rate 72 bpm.',
    target: {
      patient_id: 'PAT-909',
      blood_pressure_systolic: 120,
      blood_pressure_diastolic: 80,
      heart_rate_bpm: 72,
    },
  },
  {
    id: '23',
    text: 'Podcast episode: "Hardcore History", episode 68 released on 2026-04-01, age restricted: false.',
    target: {
      podcast_name: 'Hardcore History',
      episode_num: 68,
      broadcast_date: '2026-04-01',
      age_restricted: false,
    },
  },
  {
    id: '24',
    text: 'Procurement PO-6612 issued by Officer James Gordon for quantity 150 items with total cost $3750.00.',
    target: {
      ordering_officer: 'James Gordon',
      po_identifier: 'PO-6612',
      total_quantity: 150,
      net_cost: 3750.0,
    },
  },
  {
    id: '25',
    text: 'Domain registration record: example.org registered through NameCheap in 2020, auto renew: true.',
    target: {
      domain_name: 'example.org',
      registrar_company: 'NameCheap',
      registration_year: 2020,
      autorenewal_enabled: true,
    },
  },
];

function generate() {
  // 1. JSON Extraction
  const jsonDir = join(BASE_DIR, 'json_extraction');
  mkdirSync(jsonDir, { recursive: true });
  for (const item of jsonExtractionPrompts) {
    const filename = `${item.id}.json`;
    const promptData = {
      id: `json_${item.id}`,
      bucket: 'json_extraction',
      prompt: `Extract the requested data from the following text as a JSON object adhering to the schema:\n\n${item.text}\n\nOutput only valid JSON.`,
      referenceAnswer: JSON.stringify(item.answer, null, 2),
      schema: item.schema,
    };
    writeFileSync(join(jsonDir, filename), JSON.stringify(promptData, null, 2) + '\n', 'utf8');
  }

  // 2. Math
  const mathDir = join(BASE_DIR, 'math');
  mkdirSync(mathDir, { recursive: true });
  for (const item of mathPrompts) {
    const filename = `${item.id}.json`;
    const promptData = {
      id: `math_${item.id}`,
      bucket: 'math',
      prompt: `${item.q}\nOutput only the final numerical answer.`,
      referenceAnswer: String(item.a),
      expected: item.a,
    };
    writeFileSync(join(mathDir, filename), JSON.stringify(promptData, null, 2) + '\n', 'utf8');
  }

  // 3. Code Generation
  const codeDir = join(BASE_DIR, 'code_generation');
  mkdirSync(codeDir, { recursive: true });
  for (const item of codePrompts) {
    const filename = `${item.id}.json`;
    const promptData = {
      id: `code_${item.id}`,
      bucket: 'code_generation',
      prompt: `${item.prompt}\nOutput only the JavaScript code without extra commentary.`,
      referenceAnswer: item.code,
      entrypoint: item.entrypoint,
      testCases: item.testCases,
    };
    writeFileSync(join(codeDir, filename), JSON.stringify(promptData, null, 2) + '\n', 'utf8');
  }

  // 4. Structured Extraction
  const structDir = join(BASE_DIR, 'structured_extraction');
  mkdirSync(structDir, { recursive: true });
  for (const item of structuredExtractionPrompts) {
    const filename = `${item.id}.json`;
    const promptData = {
      id: `struct_${item.id}`,
      bucket: 'structured_extraction',
      prompt: `Extract key fields from the following record as a JSON object with keys: ${Object.keys(item.target).join(', ')}.\n\nRecord:\n${item.text}\n\nOutput only valid JSON.`,
      referenceAnswer: JSON.stringify(item.target, null, 2),
      target: item.target,
    };
    writeFileSync(join(structDir, filename), JSON.stringify(promptData, null, 2) + '\n', 'utf8');
  }

  console.log('Successfully generated 100 eval prompt files across 4 buckets.');
}

generate();

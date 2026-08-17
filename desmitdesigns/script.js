// Navbar scroll effect
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 50);
});

// Mobile nav toggle
const navToggle = document.querySelector('.nav-toggle');
const navLinks = document.querySelector('.nav-links');

navToggle.addEventListener('click', () => {
  navLinks.classList.toggle('active');
  navToggle.classList.toggle('active');
});

// Close mobile nav on link click
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('active');
    navToggle.classList.remove('active');
  });
});

// Scroll animations
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  },
  { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
);

// Add fade-in to elements
document.querySelectorAll(
  '.service-card, .portfolio-item, .equipment-card, .contact-item, .stat, .capability'
).forEach(el => {
  el.classList.add('fade-in');
  observer.observe(el);
});

// Stagger animation delays for grid items
document.querySelectorAll('.services-grid .service-card').forEach((card, i) => {
  card.style.transitionDelay = `${i * 0.1}s`;
});

document.querySelectorAll('.portfolio-grid .portfolio-item').forEach((item, i) => {
  item.style.transitionDelay = `${i * 0.1}s`;
});

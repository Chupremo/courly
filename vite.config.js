import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(process.cwd(), 'index.html'),
        login: resolve(process.cwd(), 'login.html'),
        players: resolve(process.cwd(), 'players.html'),
        business: resolve(process.cwd(), 'business.html'),
        features: resolve(process.cwd(), 'features.html'),
        pricing: resolve(process.cwd(), 'pricing.html'),
        clubs: resolve(process.cwd(), 'clubs.html'),
        courts: resolve(process.cwd(), 'courts.html'),
        ownerPortal: resolve(process.cwd(), 'owner-portal.html'),
        venue: resolve(process.cwd(), 'venue.html'),
        bookingConfirmation: resolve(process.cwd(), 'booking-confirmation.html'),
        myBookings: resolve(process.cwd(), 'my-bookings.html'),
        playerRegister: resolve(process.cwd(), 'player-register.html'),
        playerLogin: resolve(process.cwd(), 'player-login.html'),
        playerDashboard: resolve(process.cwd(), 'player-dashboard.html'),
        community: resolve(process.cwd(), 'community.html'),
        communityEvent: resolve(process.cwd(), 'community-event.html'),
        adminBilling: resolve(process.cwd(), 'admin-billing.html'),
        venueOwnerTerms: resolve(process.cwd(), 'venue-owner-terms.html'),
        coaches: resolve(process.cwd(), 'coaches.html'),
        coachProfile: resolve(process.cwd(), 'coach.html'),
        coachRegister: resolve(process.cwd(), 'coach-register.html'),
        coachLogin: resolve(process.cwd(), 'coach-login.html'),
        coachBooking: resolve(process.cwd(), 'coach-booking.html'),
        coachChat: resolve(process.cwd(), 'coach-chat.html'),
        coachPortal: resolve(process.cwd(), 'coach-portal.html'),
        coachTerms: resolve(process.cwd(), 'coach-owner-terms.html'),
        adminCoaches: resolve(process.cwd(), 'admin-coaches.html'),
        myCoachingSessions: resolve(process.cwd(), 'my-coaching-sessions.html'),
        browseClubs: resolve(process.cwd(), 'browse-clubs.html'),
        clubRegister: resolve(process.cwd(), 'club-register.html'),
        clubLogin: resolve(process.cwd(), 'club-login.html'),
        clubDashboard: resolve(process.cwd(), 'club-dashboard.html'),
        demoPlayground: resolve(process.cwd(), 'demo.html'),
        playerMessages: resolve(process.cwd(), 'player-messages.html')
      }
    }
  }
});

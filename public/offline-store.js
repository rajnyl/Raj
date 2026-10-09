(() => {
    const DATABASE_NAME = 'ncgg-offline-data';
    const DATABASE_VERSION = 1;
    let databasePromise;

    function openDatabase() {
        if (databasePromise) return databasePromise;
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains('snapshots')) {
                    database.createObjectStore('snapshots', { keyPath: 'key' });
                }
                if (!database.objectStoreNames.contains('checkins')) {
                    database.createObjectStore('checkins', { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return databasePromise;
    }

    async function getSnapshot(key) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const request = database.transaction('snapshots').objectStore('snapshots').get(key);
            request.onsuccess = () => resolve(request.result?.value);
            request.onerror = () => reject(request.error);
        });
    }

    async function saveSnapshots(snapshots) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('snapshots', 'readwrite');
            const store = transaction.objectStore('snapshots');
            for (const [key, value] of Object.entries(snapshots)) store.put({ key, value });
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Could not save offline dashboard data.'));
        });
    }

    async function listCheckins() {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const request = database.transaction('checkins').objectStore('checkins').getAll();
            request.onsuccess = () => resolve(request.result.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
            request.onerror = () => reject(request.error);
        });
    }

    async function addCheckin(checkin) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('checkins', 'readwrite');
            transaction.objectStore('checkins').add(checkin);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Could not queue this offline check-in.'));
        });
    }

    async function updateCheckin(checkin) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('checkins', 'readwrite');
            transaction.objectStore('checkins').put(checkin);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Could not update the offline check-in.'));
        });
    }

    async function removeCheckin(id) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('checkins', 'readwrite');
            transaction.objectStore('checkins').delete(id);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('Could not remove the synced check-in.'));
        });
    }

    window.offlineStore = {
        getSnapshot,
        saveSnapshots,
        listCheckins,
        addCheckin,
        updateCheckin,
        removeCheckin
    };
})();

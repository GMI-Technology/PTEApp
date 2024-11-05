const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios"); // for HTTP requests
const soap = require("soap"); // for SOAP API requests
const express = require("express");
const CryptoJS = require("crypto-js");

// Initialize Express
const app = express();

app.use(express.json());
admin.initializeApp();

const isLocal = !process.env.K_SERVICE;

// Export the Express app as a Firebase function
// Set a custom timeout (e.g., 3 minutes) for the functions
exports.app = functions
    .runWith({ timeoutSeconds: 180 }) // Set timeout to 3 minutes (180 seconds)
    .https.onRequest(app);

// POST /fetch endpoint
app.post("/fetch", async (req, res) => {
    const { email, password, locationId, privateIntegrationKey} = req.body;

    try {
        const today = new Date();
        var startDate = new Date(today);
        startDate.setDate(today.getDate() - 1);
        // Step 1: Authenticate and get the token
        const token = await authenticate(email, password);
        
        // Step 2: Retrieve patient data
        const patientData = await getPatientLastVisitReport(token, startDate);

        // Step 3: Filter patients with valid email or phone
        const validPatients = patientData.filter(patient =>
            patient.Email || patient.Phone
        );

        // Step 4: Fetch custom field IDs for mapping
        const customFields = await fetchCustomFields(locationId, privateIntegrationKey);
        const fieldMap = {};
        customFields.forEach(field => {
            fieldMap[field.name] = field.id;
        });

        // Step 5: Upsert each valid patient
        for (const patient of validPatients) {
            const contactData = {
                firstName: patient.PatientFirstName,
                lastName: patient.PatientLastName,
                email: patient.Email || null,
                phone: patient.Phone || null,
                customFieldData: {
                    [fieldMap["PatientId"]]: patient.PatientId,
                    [fieldMap["Age"]]: patient.Age,
                    [fieldMap["LastSeenBy"]]: patient.LastSeenBy,
                    [fieldMap["LastVisit"]]: patient.LastVisit,
                    [fieldMap["NextVisit"]]: patient.NextVisit,
                    [fieldMap["Service"]]: patient.Service,
                    [fieldMap["OpenCaseStr"]]: patient.OpenCaseStr
                }
            };

            try {
                await upsertContact(contactData, locationId, privateIntegrationKey);
                console.log(`Successfully upserted contact for ${patient.PatientName}`);
            } catch (error) {
                console.error(`Failed to upsert contact for ${patient.PatientName}:`, error.message);
            }
        }

        res.status(200).json({ message: "All valid patients have been processed." });
    } catch (error) {
        console.error("Error in fetch function:", error.message);
        res.status(500).json({ error: "Failed to process patients", details: error.message });
    }
});

// Export the Express API as a Firebase Function
exports.fetch = functions.https.onRequest(app);

// POST /new_install endpoint
app.post("/new_install", async (req, res) => {
    const { email, password, locationId, privateIntegrationKey, startDate = null } = req.body;

    try {
        // Step 1: Create custom fields
        await createCustomFields(locationId, privateIntegrationKey);

        // Step 2: Authenticate and get the token
        const token = await authenticate(email, password);
        
        // Step 3: Retrieve patient data
        const patientData = await getPatientLastVisitReport(token, startDate);

        // Step 4: Filter patients with valid email or phone
        const validPatients = patientData.filter(patient =>
            patient.Email || patient.Phone
        );

        // Step 5: Fetch custom field IDs for mapping
        const customFields = await fetchCustomFields(locationId, privateIntegrationKey);
        const fieldMap = {};
        customFields.forEach(field => {
            fieldMap[field.name] = field.id;
        });

        // Step 6: Upsert each valid patient
        for (const patient of validPatients) {
            const contactData = {
                firstName: patient.PatientFirstName,
                lastName: patient.PatientLastName,
                email: patient.Email || null,
                phone: patient.Phone || null,
                customFieldData: {
                    [fieldMap["PatientId"]]: patient.PatientId,
                    [fieldMap["Age"]]: patient.Age,
                    [fieldMap["LastSeenBy"]]: patient.LastSeenBy,
                    [fieldMap["LastVisit"]]: patient.LastVisit,
                    [fieldMap["NextVisit"]]: patient.NextVisit,
                    [fieldMap["Service"]]: patient.Service,
                    [fieldMap["OpenCaseStr"]]: patient.OpenCaseStr
                }
            };

            try {
                await upsertContact(contactData, locationId, privateIntegrationKey);
                console.log(`Successfully upserted contact for ${patient.PatientName}`);
            } catch (error) {
                console.error(`Failed to upsert contact for ${patient.PatientName}:`, error.message);
            }
        }

        res.status(200).json({ message: "Custom fields created and all valid patients processed." });
    } catch (error) {
        console.error("Error in new_install function:", error.message);
        res.status(500).json({ error: "Failed to complete installation and process patients", details: error.message });
    }
});

// Export the new_install function
exports.new_install = functions.https.onRequest(app);


async function createCustomFields(locationId, privateIntegrationKey) {
    const url = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;
    
    const headers = {
        'Version': '2021-07-28',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${privateIntegrationKey}`,
    };

    // Define the custom fields to be created with their respective data types
    const fields = [
        { name: "PatientId", dataType: "TEXT" },
        { name: "Age", dataType: "NUMERICAL" },
        { name: "LastSeenBy", dataType: "TEXT" },
        { name: "LastVisit", dataType: "DATE" },
        { name: "NextVisit", dataType: "DATE" },
        { name: "Service", dataType: "TEXT" },
        { name: "OpenCaseStr", dataType: "TEXT" },
    ];

    for (const field of fields) {
        const customFieldPayload = {
            name: field.name,
            dataType: field.dataType,
            placeholder: field.name, // Placeholder can be the field name, or customize if needed
            position: 0, // Position could be set dynamically if needed
            model: 'contact',
            acceptedFormat: [],
            isMultipleFile: false,
            maxNumberOfFiles: 0,
            textBoxListOptions: []
        };

        try {
            const response = await axios.post(url, customFieldPayload, { headers });
            console.log(`Custom field '${field.name}' created successfully:`, response.data);
        } catch (error) {
            console.error(`Error creating custom field '${field.name}':`, error.response?.data || error.message);
            throw error;
        }
    }
}

// Fetch existing custom fields for the location
const fetchCustomFields = async (locationId, privateIntegrationKey) => {
    const url = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;

    const headers = {
        'Version': '2021-07-28',
        'Accept': 'application/json',
        'Authorization': `Bearer ${privateIntegrationKey}`
    };

    try {
        const response = await axios.get(url, { headers });
        console.log("Custom fields fetched successfully:", response.data.customFields);
        return response.data.customFields;
    } catch (error) {
        console.error("Error fetching custom fields:", error.response?.data || error.message);
        throw error;
    }
};

const upsertContact = async (contactData, locationId, privateIntegrationKey) => {
    const url = "https://services.leadconnectorhq.com/contacts/upsert";

    // Step 1: Fetch and map required custom fields by name to their IDs
    const customFieldsData = await fetchCustomFields(locationId, privateIntegrationKey);
    const requiredCustomFields = ["PatientId", "Age", "LastSeenBy", "LastVisit", "NextVisit", "Service", "OpenCaseStr"];
    const customFieldIds = {};

    customFieldsData.forEach(field => {
        if (requiredCustomFields.includes(field.name)) {
            customFieldIds[field.name] = field.id;
            if (isLocal) {
                console.log(`Mapped custom field: ${field.name} -> ${field.id}`);
            }
            
        }
    });

    // Step 2: Prepare custom fields array with ID and value from contactData.customFieldData
    const customFieldsArray = Object.keys(customFieldIds).map(fieldName => {
        const fieldId = customFieldIds[fieldName];
        const fieldValue = contactData.customFieldData[fieldId]; // Access the value by ID in customFieldData
        return { id: fieldId, field_value: fieldValue };
    }).filter(field => field.field_value !== undefined); // Filter out undefined values

    console.log("Prepared custom fields array:", customFieldsArray);

    // Prepare headers
    const headers = {
        'Version': '2021-07-28',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${privateIntegrationKey}`
    };

    // Prepare the upsert payload
    const upsertData = {
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        name: `${contactData.firstName} ${contactData.lastName}`,
        email: contactData.email,
        locationId: locationId,
        gender: contactData.gender || "unknown",
        phone: contactData.phone,
        dateOfBirth: contactData.dob,
        address1: contactData.address1 || "",
        city: contactData.city || "",
        state: contactData.state || "",
        postalCode: contactData.postalCode || "",
        website: contactData.website || "",
        timezone: contactData.timezone || "America/Chihuahua",
        dnd: contactData.dnd || false,
        dndSettings: contactData.dndSettings || {},
        inboundDndSettings: contactData.inboundDndSettings || {},
        tags: contactData.tags || [],
        customFields: customFieldsArray, // Use mapped custom fields
        source: "public api",
        country: contactData.country || "US",
        companyName: contactData.companyName || "",
        assignedTo: contactData.assignedTo || ""
    };

    console.log("Upsert payload prepared:", JSON.stringify(upsertData, null, 2));

    try {
        // Step 3: Send the upsert request
        const response = await axios.post(url, upsertData, { headers });
        if (isLocal) {
            console.log("Contact upserted successfully:", response.data);
        }
        
        return response.data;
    } catch (error) {
        console.error("Error upserting contact data:", error.response?.data || error.message);
        throw error;
    }
};

// Function to authenticate and retrieve a token
const authenticate = async (email, password) => {
    const url = "https://api.pteverywhere.com/api/v2Authenticate?apiVersion=1";

    // Hash the password using MD5
    const hashedPassword = CryptoJS.MD5(password).toString();

    const payload = {
        userInfo: {
            Email: email,
            Password: hashedPassword, // Use the hashed password here
            LocalTimeZone: "Australia/Sydney"
        },
        token: "",
        userRoleSelected: "Admin",
        currentVersion: 1626,
        currentPlatform: "web",
        ApiStartTime: new Date().toISOString()
    };

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        // Extract the token from the response
        const token = response.data?.data?.[0]?.Token?.TokenValue;

        if (!token) {
            throw new Error("Token not found in response");
        }

        console.log("Authentication successful. Token received:", token);
        return token;
    } catch (error) {
        console.error("Error during authentication:", error.response?.data || error.message);
        throw error;
    }
};



// Function to get the Patient Last Visit Report
const getPatientLastVisitReport = async (token, startDate = null, currentVersion = 1626) => {
    const url = "https://api.pteverywhere.com/api/v4PatientLastVisitReportPagingATP?apiVersion=1";

    // Prepare the payload with current time for endDate and optional startDate
    const payload = {
        startDate: startDate,
        endDate: new Date().toISOString(), // Current date and time in ISO format
        providers: [],
        patients: [],
        services: [],
        checkPatientsNoApp: true,
        exportType: "no-export",
        sortType: "LastVisit",
        sortReverse: true,
        token: token,
        userRoleSelected: "Admin",
        currentVersion: currentVersion,
        ApiStartTime: new Date().toISOString() // Current timestamp for ApiStartTime
    };

    try {
        // Make the POST request
        const response = await axios.post(url, payload, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.data) {
            console.log("Patient Last Visit Report retrieved successfully:", response.data.data);
            return response.data.data;
        } else {
            console.error("Unexpected response format:", response.data);
            throw new Error("Unexpected response format.");
        }
    } catch (error) {
        console.error("Error fetching Patient Last Visit Report:", error.response?.data || error.message);
        throw error;
    }
};


// Start the server locally
// const port = process.env.PORT || 8081;
// app.listen(port, () => {
//     console.log(`Server is running on port ${port}`);
// });